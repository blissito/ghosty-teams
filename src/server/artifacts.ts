import { createServerFn } from "@tanstack/react-start";
import { stampIds } from "../lib/artifact-ids";

/**
 * Publica una VERSIÓN nueva de un artefacto. Camino ÚNICO para el agente (chat.ts, al
 * cerrar el fence) y para la edición humana (updateArtifactHtmlFn): estaban duplicados
 * literalmente y cualquier arreglo en uno se olvidaba en el otro.
 *
 * Hace, en orden: SEMBRAR los `data-id` (idempotente — es lo que hace direccionable el
 * artefacto para el próximo ```eb-patch```), publicar el HTML a storage (link compartible),
 * INSERT en gc_artifacts (append-only: cada versión es una fila, getDoc toma la última),
 * apuntar el hilo a ese documentId y refrescar el room.
 *
 * Devuelve el HTML finalmente persistido (ya estampado) — el llamador lo necesita para
 * publicarlo al bus / re-inyectarlo al agente.
 */
/**
 * Marcador para la burbuja cuando el documento salió con un hueco.
 *
 * ⚠️ Existe porque el fallo era MUDO: una imagen que no se pudo traer moría en un
 * `console.error` y el documento se entregaba igual, con el turno en verde. Ni el
 * agente ni la persona se enteraban — se veía como un documento completo. Nombra las
 * rutas que fallaron porque la causa casi siempre está ahí a la vista: una ruta de la
 * caja del agente (`logo.png`, `/tmp/…`) en vez de la URL de un archivo publicado.
 *
 * Mismo criterio que el marcador de `patchOutcome` en `bubbleWithoutEbDoc`: lo que el
 * servidor descubrió y el modelo no podía saber, se dice en la burbuja.
 */
export function imageGapNotice(failed: string[]): string {
  if (!failed.length) return "";
  const cuales = failed.slice(0, 3).map((u) => `\`${u.slice(0, 60)}\``).join(", ");
  const resto = failed.length > 3 ? ` y ${failed.length - 3} más` : "";
  return failed.length === 1
    ? `⚠️ El documento quedó sin una imagen: no pude traer ${cuales}.`
    : `⚠️ El documento quedó sin ${failed.length} imágenes: no pude traer ${cuales}${resto}.`;
}

export async function publishArtifactVersion(args: {
  messageId: number;
  documentId: string;
  kind: "doc" | "sheet" | "artifact";
  title: string | null;
  md: string;
  /** Apunta la conversación a este documentId (room → setThreadArtifact; DM → setDmArtifact). */
  setPointer?: (documentId: string) => Promise<void>;
  /** Avisa a los clientes de que hay versión nueva (cada superficie tiene su fanout). */
  notify?: () => void;
  /** El DM publica el objeto como público; el room, privado firmado. */
  visibility?: "public" | "private";
  /**
   * Dueño del artefacto = quien lo pidió (el invocador del turno), NO el agente.
   * Es a quien pertenece el link compartible y el único que puede cambiar sus
   * permisos. Sólo pesa en la fila raíz; las versiones siguientes lo llevan por
   * consistencia. Si falta, el lector cae al join por gc_messages.sender_sub.
   */
  ownerSub?: string | null;
  /**
   * Sólo para `kind:"doc"` en la edición HUMANA: los bloques que ya tiene el editor.
   * Sin esto habría que re-derivarlos del markdown, y eso les cambia el uuid a todos
   * (los alias del turno anterior dejarían de resolver).
   */
  blocks?: import("../lib/doc-blocks").DocBlock[];
  /** Marca el sobre: desde aquí `sourceMd` ya no es la verdad del documento. */
  humanEdited?: boolean;
  /** Bloques que cambiaron en ESTA versión → el editor los señala al abrirse. */
  changedIds?: string[];
  /** Quiénes co-editaron en la sesión que dejó esta versión (`sub`). Sólo la co-edición. */
  authors?: string[];
  /**
   * Exportar este documento SIN la marca del espacio. `undefined` = lo que ya dijera el
   * documento (se hereda); `true`/`false` lo fijan.
   *
   * Es del DOCUMENTO, no de la versión: un oficio pedido sin membrete lo sigue estando
   * después de editarlo.
   */
  unbranded?: boolean;
  /**
   * El sobre de la versión anterior, cuando quien llama YA lo tiene leído (el patch de
   * `eb-patch`, el restore de una versión). Ahorra la lectura y, sobre todo, deja
   * DECIDIR de qué versión se hereda — que en un restore no es la última.
   *
   * `undefined` = léelo tú. `null` = no heredes nada (documento nuevo).
   */
  previo?: import("../lib/doc-blocks").DocEnvelope | null;
  /**
   * `false` publica el HTML TAL CUAL: sin sembrar `data-id` y sin hornear Tailwind.
   * Lo usan los artefactos que NO escribió el agente y que por lo tanto no se editan
   * por `eb-patch` — hoy, los formularios nativos (`forms/publish.server.ts`), cuyo
   * HTML es determinista, trae su propio CSS y cuyo JS no debe pasar por un
   * transformador de DOM. Por defecto `true`: el camino del agente no cambia.
   */
  stamp?: boolean;
  // `versionId` es la fila que se acaba de INSERTar. El editor la fija para que leer en
  // voz alta / revisar la ortografía miren la versión que él tiene pintada y no "la
  // última" — que en un hilo con dos documentos es el OTRO documento.
}): Promise<{ md: string; src: string | null; versionId: number; imagesFailed: string[] }> {
  const db = await import("../db.server");
  const t0 = performance.now();

  let md = args.md;
  // Imágenes que no se pudieron resolver (ver `rehostMarkdownImages`). Viaja hasta el
  // llamador para que el mensaje lo DIGA: un documento con un hueco que nadie anuncia se
  // lee como un documento completo.
  let imagesFailed: string[] = [];

  // Un DOC se persiste como ÁRBOL DE BLOQUES (sobre `v:1`), no como markdown: los uuid
  // de los bloques son lo que hace direccionable el documento para el próximo
  // ```eb-patch```. Es el equivalente de `stampIds` del HTML, pero los ids no se
  // estampan — vienen de BlockNote al parsear (los propios se ignoran).
  //
  // `blocks` llega cuando la edición es HUMANA: el editor ya tiene los bloques, y
  // re-derivarlos del markdown les cambiaría los uuid a todos.
  if (args.kind === "doc") {
    const { docEnvelopeFromMd } = await import("./doc-blocks.server");
    const { serializeDocEnvelope, parseDocEnvelope } = await import("../lib/doc-blocks");
    // El sobre de la versión ANTERIOR de este documento. Se lee aquí, una vez, y lo heredan
    // las dos ramas: sin esto cada versión nacía desde cero y se perdía lo que es del
    // DOCUMENTO y no de la versión — hoy `sourceMd` y la marca. `args.previo` deja que el
    // llamador lo aporte cuando ya lo tiene en la mano (el patch de `eb-patch`, el restore)
    // y evita una lectura de más.
    const previo =
      args.previo !== undefined
        ? args.previo
        : parseDocEnvelope((await db.latestDocVersion(args.documentId).catch(() => null))?.md);
    if (args.blocks?.length) {
      md = serializeDocEnvelope({
        blocks: args.blocks,
        humanEdited: args.humanEdited,
        changedIds: args.changedIds,
        unbranded: args.unbranded,
        previo,
      });
    } else {
      // Las imágenes que trae el agente apuntan a una presignada del box (7 días).
      // Se re-hospedan ANTES de volverse bloques, para que el documento nazca
      // apuntando a nuestro storage: si no, se ve completo hoy y sale con huecos
      // el mes que viene. Es el mismo criterio que `eb-file` aplica a los archivos.
      const { rehostMarkdownImages } = await import("./published-attach.server");
      const conImagenes = await rehostMarkdownImages(args.md).catch((e) => {
        console.error("[artifact] re-hospedar imágenes falló", e);
        return { md: args.md, failed: [] as string[] };
      });
      imagesFailed = conImagenes.failed;
      md = await docEnvelopeFromMd(conImagenes.md, previo, args.unbranded);
    }
  }

  // Solo el HTML tiene nodos que direccionar por DOM; sheet es CSV.
  if (args.kind === "artifact" && args.stamp !== false) {
    try {
      const { serverParseOpts } = await import("./artifact-dom.server");
      md = stampIds(args.md, await serverParseOpts());
    } catch (e) {
      // Sin ids el artefacto sigue siendo válido: solo pierde la edición quirúrgica
      // en el siguiente turno (artifactDocHint lo detecta y pide re-emisión completa).
      console.error("[artifact] stampIds failed", e);
    }
    // Hornea el CSS de Tailwind → el artefacto abre YA estilado, sin el frame crudo que
    // dejaba el CDN al compilar en el navegador. Best-effort: si falla, sale con CDN.
    try {
      const { bakeTailwind } = await import("./artifact-css.server");
      const brand = await import("./brand.server")
        .then((m) => m.activeBrandKit())
        .catch(() => null);
      md = await bakeTailwind(md, brand);
    } catch (e) {
      console.error("[artifact] bakeTailwind failed", e);
    }
  }

  let src: string | null = null;
  if (args.kind === "artifact") {
    try {
      const storage = await import("./storage.server");
      if (storage.storageConfigured()) {
        // Bucket PRIVADO: el "público" de Tigris no sirve objetos sin firma (AccessDenied).
        // La URL branded artefacto.ghosty.studio/<key> la sirve el app (ruta /t3/$) leyendo
        // el objeto firmado → público y permanente.
        const visibility = args.visibility ?? "private";
        const put = await storage.put({
          blob: new Blob([md], { type: "text/html" }),
          contentType: "text/html; charset=utf-8",
          fileName: `${(args.title || "artefacto").slice(0, 60)}.html`,
          visibility,
        });
        // El link branded oculta el prefijo interno `t3/` (Caddy lo re-antepone en el vhost).
        const base = process.env.ARTIFACT_PUBLIC_BASE?.replace(/\/$/, "");
        src =
          visibility === "public"
            ? base
              ? `${base}/${put.key}`
              : storage.publicUrl(put.key)
            : base
              ? `${base}/${put.key.replace(/^t3\//, "")}`
              : storage.signedUrl(put.key, 604800, "private");
      }
    } catch (e) {
      console.error("[artifact] publish failed", e);
    }
  }

  const versionId = await db.createArtifact(args.messageId, {
    kind: args.kind,
    url: args.documentId,
    title: args.title,
    md,
    src,
    ownerSub: args.ownerSub ?? null,
    authors: args.authors ?? null,
  });
  // Poda las versiones viejas (fila + objeto). Best-effort y DESPUÉS del INSERT: si
  // falla, sólo queda basura, nunca se pierde la versión que acabamos de publicar.
  try {
    const gone = await db.pruneArtifactVersions(args.documentId);
    if (gone.length) {
      const storage = await import("./storage.server");
      for (const src of gone) {
        const key = storageKeyFromSrc(src);
        if (!key) continue;
        // Se intenta en los dos buckets porque `visibility` es del turno que la
        // publicó, no del que poda: un DM publicó público y un room, privado.
        await storage.del(key, "private").catch(() => false);
        await storage.del(key, "public").catch(() => false);
      }
      console.log(`[artifact prune] ${args.documentId} -${gone.length} versiones`);
    }
  } catch (e) {
    console.error("[artifact] prune failed", e);
  }

  try {
    await args.setPointer?.(args.documentId);
  } catch {
    /* el puntero es una comodidad; la versión ya está guardada */
  }
  try {
    args.notify?.();
  } catch {
    /* best-effort: la versión ya está guardada */
  }
  console.log(
    `[artifact publish] kind=${args.kind} ${Math.round(performance.now() - t0)}ms html=${md.length}b src=${src ? "sí" : "no"}`
  );
  return { md, src, versionId, imagesFailed };
}

/**
 * La key del bucket a partir del `src` guardado. Hay DOS formas de link vivas —el
 * branded `<base>/<uuid>-name.html` (sin el prefijo interno) y la URL firmada con
 * `t3/` y query— así que lo estable es el último segmento del path.
 */
export function storageKeyFromSrc(src: string): string | null {
  const path = src.split("?")[0];
  const name = path.split("/").filter(Boolean).pop();
  return name && /\.html$/i.test(name) ? `t3/${name}` : null;
}

// ── Compartir ───────────────────────────────────────────────────────────────────
// El estado de compartir es del DOCUMENTO, no de la versión: vive en la fila RAÍZ
// (la más vieja del mismo documentId) porque cada publicación inserta una fila nueva.
// Dos estados nada más: "private" (sólo el dueño) y "link" (cualquiera con el link).

/**
 * El enlace que se le entrega a una PERSONA para un artefacto: `/artefacto/<slug>`.
 *
 * NO se reparte `gc_artifacts.src` (la URL branded `artefacto.ghosty.studio/<key>`, que
 * sirve la ruta `/t3/$`). Ese host es OTRO origen —a propósito, para aislar el HTML del
 * agente— y la cookie `gc_session` es host-only (`session.server.ts`), así que allá la
 * sesión SIEMPRE es anónima: desde que `/t3` aplica el permiso, un artefacto que no esté
 * compartido por liga responde 404 hasta a su propio dueño. `/artefacto/<slug>` corre en
 * el host del equipo, donde la sesión sí existe, y aplica el mismo criterio.
 *
 * El slug se acuña aquí si falta — es sólo una dirección, NO abre nada: la visibilidad se
 * queda como estaba, y `resolveSharedArtifact` sigue devolviendo null a quien no tenga
 * permiso. Es lo mismo que hace el panel al abrirse (`setArtifactShareFn`), y no rota
 * nunca: si rotara, los links ya pegados morirían en silencio.
 *
 * El host sale de la petición en curso porque el tenant se resuelve por SUBDOMINIO: un
 * enlace al apex cae en otro namespace y el artefacto "no existe". Fuera de una petición
 * no hay a qué equipo apuntar → null, y quien llame se queda sin línea de enlace.
 */
export async function shareLinkFor(documentId: string): Promise<string | null> {
  try {
    const db = await import("../db.server");
    const root = await db.shareRootFor(documentId);
    if (!root) return null;
    let slug = root.slug;
    if (!slug) {
      slug = crypto.randomUUID();
      await db.setShareOnRoot(root.id, { slug });
    }
    const { getRequestHeader, getRequestHost, getRequestProtocol } = await import(
      "@tanstack/react-start/server"
    );
    const host = getRequestHeader("x-forwarded-host") || getRequestHost();
    if (!host) return null;
    const proto = getRequestHeader("x-forwarded-proto") || getRequestProtocol() || "https";
    return `${proto}://${host}/artefacto/${slug}`;
  } catch (e) {
    console.error("[artifact] shareLinkFor falló", e);
    return null;
  }
}

export type ArtifactShare = {
  slug: string | null;
  visibility: "private" | "link";
  /** Qué puede hacer quien llega por el link: ver · comentar · editar. */
  role: import("../db.server").DocRole;
  /** id de la versión congelada; null = Latest (sigue lo último que se publique). */
  sharedArtifactId: number | null;
  /** `authors` = nombres de quienes co-editaron esa sesión; vacío = versión del agente. */
  versions: { id: number; label: string; createdAt: number; authors: string[] }[];
  owner: { sub: string | null; name: string | null; email: string | null; avatar: string | null };
  isOwner: boolean;
};

// El dueño manda: sólo él ve y cambia los permisos. Si la raíz no trae owner_sub
// (artefactos anteriores a esta feature) se cae al autor del mensaje ancla, que es
// lo que ya usaba el scope de lectura de documents.ts.
export async function requireShareOwner(documentId: string) {
  const { sessionUser } = await import("./chat");
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const db = await import("../db.server");
  const root = await db.shareRootFor(documentId);
  if (!root) throw new Error("artefacto no encontrado");
  // El dueño del workspace también manda: administra el equipo, así que un documento del
  // equipo no puede quedarse incompartible porque su autor se fue.
  if (root.ownerSub && root.ownerSub !== me.sub && !me.isOwner)
    throw new Error("no eres el dueño de este artefacto");
  return { me, root, db };
}

async function shareStateFor(
  documentId: string,
  meSub: string | null,
  /**
   * Dueño del WORKSPACE. Manda sobre el dueño del artefacto: quien administra el equipo
   * tiene que poder abrir o cerrar un documento del equipo sin perseguir a quien lo creó
   * (o sin quedarse trabado si esa persona ya no está).
   */
  meIsWorkspaceOwner = false
): Promise<ArtifactShare | null> {
  const db = await import("../db.server");
  const root = await db.shareRootFor(documentId);
  if (!root) return null;
  const versions = await db.listArtifactVersions(documentId);
  let owner = { sub: root.ownerSub, name: null as string | null, email: null as string | null, avatar: null as string | null };
  if (root.ownerSub) {
    const { dbq } = await import("../dbq.server");
    const rows = await dbq(`SELECT name, email, avatar FROM gc_users WHERE sub = ? LIMIT 1`, [root.ownerSub]);
    if (rows[0]) owner = { sub: root.ownerSub, name: rows[0].name ?? null, email: rows[0].email ?? null, avatar: rows[0].avatar ?? null };
  }
  // Un solo viaje para todos los autores del historial: son pocos y repetidos.
  const nombres = new Map<string, string>();
  const subsAutores = [...new Set(versions.flatMap((v) => v.authors))];
  if (subsAutores.length) {
    const { dbq } = await import("../dbq.server");
    const rows = await dbq(
      `SELECT sub, name, email FROM gc_users WHERE sub IN (${subsAutores.map(() => "?").join(",")})`,
      subsAutores
    ).catch(() => [] as Awaited<ReturnType<typeof import("../dbq.server").dbq>>);
    for (const r of rows) {
      if (r.sub) nombres.set(r.sub, r.name || r.email || "Alguien");
    }
  }

  return {
    slug: root.slug,
    visibility: root.visibility,
    role: root.role,
    sharedArtifactId: root.sharedArtifactId,
    versions: versions.map((v, i) => ({
      id: v.id,
      label: `Versión ${i + 1}`,
      createdAt: v.createdAt,
      // Nombres, no `sub`: el historial lo lee gente. Una versión del agente no trae
      // autores y se queda sin firma, que es lo correcto — no es de nadie del equipo.
      authors: v.authors.map((sub) => nombres.get(sub) ?? "Alguien"),
    })),
    owner,
    // Sin owner_sub (artefacto viejo) cualquiera del workspace que lo vea puede
    // adoptarlo: es preferible a dejarlo sin dueño y por tanto incompartible.
    isOwner: !root.ownerSub || root.ownerSub === meSub || meIsWorkspaceOwner,
  };
}

/**
 * Resuelve un link público /a/<slug> → la versión que hay que servir, aplicando el
 * permiso. Lo usan la página (chrome) y /a/$id/raw (el HTML dentro del iframe), y
 * es a propósito el MISMO camino: si se separaran, uno podría filtrar lo que el
 * otro bloquea.
 *
 * Devuelve null tanto si no existe como si no se tiene acceso — el llamador
 * responde 404 en los dos casos. Un 403 confirmaría que el artefacto existe.
 */
export async function resolveSharedArtifact(
  slug: string,
  meSub: string | null,
  /**
   * Qué versión MIRAR, si quien abre lo pidió explícitamente: `"latest"` (lo que manda
   * el panel al abrir en pestaña nueva — "enséñame lo que estoy viendo") o el id de una.
   * Manda sobre la versión fijada, que es una promesa a quien recibe TU enlace, no una
   * instrucción sobre lo que tú acabas de pedir ver.
   */
  view?: string | null
): Promise<{
  root: { id: number; url: string; ownerSub: string | null; visibility: "private" | "link" };
  /** `src` = la URL del CDN (artefacto.ghosty.studio/<key>) de ESA versión. */
  version: { id: number; title: string | null; md: string | null; src: string | null; createdAt: number };
  versionLabel: string | null;
  isOwner: boolean;
} | null> {
  const db = await import("../db.server");
  const root = await db.shareRootBySlug(slug);
  if (!root) return null;
  const isOwner = !!meSub && (!root.ownerSub || root.ownerSub === meSub);
  if (root.visibility !== "link" && !isOwner) return null;

  const versions = await db.listArtifactVersions(root.url);
  if (!versions.length) return null;
  // Versión CONGELADA si la hay: editar después no cambia lo que el otro ya vio.
  // Si la congelada se borró, se cae a la última en vez de romper el link.
  // La versión ELEGIDA manda, también para el dueño: si no, el selector no hace nada
  // visible y parece descompuesto (que es como se ve forzar "siempre la última").
  // Para ver lo vivo se elige "La más reciente", que es el default.
  const wanted =
    view === "latest"
      ? versions.length - 1
      : view && Number.isFinite(Number(view))
        ? versions.findIndex((v) => v.id === Number(view))
        : -1;
  const idx =
    wanted >= 0
      ? wanted
      : root.sharedArtifactId
        ? versions.findIndex((v) => v.id === root.sharedArtifactId)
        : -1;
  const chosen = idx >= 0 ? versions[idx] : versions[versions.length - 1];
  const full = await db.getArtifactVersion(chosen.id);
  if (!full) return null;
  return {
    root: { id: root.id, url: root.url, ownerSub: root.ownerSub, visibility: root.visibility },
    version: { id: full.id, title: full.title, md: full.md, src: full.src, createdAt: full.createdAt },
    // "fijada" y no sólo el número: el badge a secas se lee como "ésta es la actual", y
    // abrir el enlace y encontrarte una versión vieja de lo que tienes en pantalla parece
    // un bug. Sólo aparece cuando alguien la congeló a propósito.
    // "fijada" sólo cuando lo que se sirve es la versión congelada; si la pidió quien
    // abre (?v=…), es simplemente la versión que está mirando.
    versionLabel:
      idx < 0
        ? null
        : wanted >= 0
          ? idx === versions.length - 1
            ? null
            : `Versión ${idx + 1}`
          : `Versión ${idx + 1} · fijada`,
    isOwner,
  };
}

export const getArtifactShareFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    return await shareStateFor(data.documentId, me.sub, me.isOwner);
  });

export const setArtifactShareFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      documentId: string;
      visibility?: "private" | "link";
      sharedArtifactId?: number | null;
      /** Nivel del enlace: ver (default) · comentar · editar (entra a la sala de co-edición). */
      role?: import("../db.server").DocRole;
    }) => d
  )
  .handler(async ({ data }) => {
    const { me, root, db } = await requireShareOwner(data.documentId);

    // El slug se acuña la PRIMERA vez que se comparte y ya no cambia: si rotara,
    // los links que la gente ya pegó en otro lado morirían en silencio. Revocar es
    // volver a "private", no cambiar de dirección.
    const slug = root.slug ?? crypto.randomUUID();

    // Adopción del artefacto viejo sin dueño (ver isOwner): el primero que lo
    // comparte queda como dueño, si no nadie podría volver a cerrarlo.
    const patch: Parameters<typeof db.setShareOnRoot>[1] = { slug };
    if (data.visibility !== undefined) patch.visibility = data.visibility;
    if (data.role !== undefined) patch.role = data.role;
    if (data.sharedArtifactId !== undefined) {
      // Sólo se puede congelar una versión de ESTE documento.
      if (data.sharedArtifactId !== null) {
        const v = await db.getArtifactVersion(data.sharedArtifactId);
        if (!v || v.url !== data.documentId) throw new Error("esa versión no es de este artefacto");
      }
      patch.sharedArtifactId = data.sharedArtifactId;
    }
    await db.setShareOnRoot(root.id, patch);
    if (!root.ownerSub) {
      const { dbq } = await import("../dbq.server");
      await dbq(`UPDATE gc_artifacts SET owner_sub = ? WHERE url = ?`, [me.sub, data.documentId]);
    }
    return await shareStateFor(data.documentId, me.sub, me.isOwner);
  });

// Guardado de artefactos HTML editados desde el Canvas (editor @ghosty/canvas-editor)
// en el ArtifactPanel. Camino GEMELO al que usa el agente en chat.ts al cerrar un
// eb-doc kind:"artifact": publica el HTML a storage (link compartible) y escribe una
// NUEVA versión en gc_artifacts (INSERT = versión nueva; getDoc toma la última). No
// pasa por el agente — es una edición humana directa sobre el mismo documentId.
/**
 * Guarda la edición HUMANA de un documento: publica una versión nueva desde los BLOQUES
 * que ya tiene el editor. Hermano de `updateArtifactHtmlFn` (mismo fallback de messageId,
 * mismo lookup de canal/hilo, mismo `publishArtifactVersion`).
 *
 * Se pasan los bloques, no markdown: re-derivarlos les cambiaría el uuid a TODOS y los
 * alias que el agente vio en el turno anterior dejarían de resolver. Y se marca
 * `humanEdited` — desde aquí el `sourceMd` del agente ya no describe el documento.
 *
 * La CADENCIA la controla el cliente (debounce + techo por minuto), no este handler:
 * cada llamada es un INSERT y `pruneArtifactVersions` sólo guarda 20 versiones, así que
 * un autosave por pulsación se comería las versiones del agente en un minuto de tecleo.
 */
/**
 * La SUPERFICIE donde vive un documento: el mensaje que lo ancla, el room o DM al que
 * pertenece, cómo se avisa a los demás y cómo se mueve el puntero de la conversación.
 *
 * Esto estaba copiado LITERALMENTE en `updateDocBlocksFn` y `updateArtifactHtmlFn` —el
 * mismo fallback de messageId, el mismo SELECT, el mismo `avisar`, el mismo `setPointer`—
 * y restaurar una versión lo necesitaba por tercera vez. Se extrae en vez de triplicarlo:
 * son los cuatro sitios donde una divergencia entre room y DM se paga con un guardado que
 * falla en silencio (ver el comentario del 2026-08-02 sobre `channel_id` en DMs).
 */
async function docSurface(documentId: string, messageIdHint: number | undefined, meSub: string) {
  const { dbq, num } = await import("../dbq.server");

  // El cliente propaga el messageId del ArtifactView; si falta, la última fila de
  // gc_artifacts (todas las versiones cuelgan del MISMO mensaje).
  let messageId = messageIdHint;
  if (!messageId || messageId <= 0) {
    const rows = await dbq(
      `SELECT message_id FROM gc_artifacts WHERE url = ? ORDER BY id DESC LIMIT 1`,
      [documentId]
    );
    messageId = num(rows[0]?.message_id);
  }
  if (!messageId) throw new Error("no se encontró el mensaje del documento");

  // ⚠️ Un documento puede vivir en un ROOM o en un DM. Hasta el 2026-08-02 esto sólo sabía
  // de rooms: en un DM (`channel_id` = 0) lanzaba antes de escribir nada, y el fallo era
  // mudo — desde fuera parecía un caché que no soltaba el texto viejo.
  const rows = await dbq(`SELECT channel_id, parent_id, dm_id FROM gc_messages WHERE id = ?`, [messageId]);
  if (!rows.length) throw new Error("no se encontró el mensaje del documento");
  const channelId = num(rows[0]?.channel_id);
  const parentId = rows[0]?.parent_id != null ? num(rows[0].parent_id) : null;
  const dmId = rows[0]?.dm_id != null ? num(rows[0].dm_id) : 0;
  if (!channelId && !dmId) throw new Error("no se encontró el canal del documento");

  // Cada superficie tiene su propio fanout: el room publica al canal; el DM, a cada miembro
  // por su bus de usuario (no hay canal al que publicar).
  // ⚠️ Va como `refresh`, NUNCA `message:new`: eso despertaría al agente por una edición.
  const avisar = async () => {
    const bus = await import("./bus.server");
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    if (dmId) {
      const db = await import("../db.server");
      const miembros = await db.getDmMembers(dmId).catch(() => [] as string[]);
      for (const sub of miembros.length ? miembros : [meSub]) {
        bus.publish(bus.ch.user(ns, sub), { t: "refresh", channelId: null, parentId: null, dmId });
      }
      return;
    }
    bus.publish(bus.ch.room(ns, channelId), { t: "refresh", channelId, parentId });
  };

  const setPointer = async (docId: string) => {
    const db = await import("../db.server");
    if (dmId) await db.setDmArtifact(dmId, docId);
    else await db.setThreadArtifact(channelId, parentId, docId);
  };

  return { messageId, channelId, parentId, dmId, avisar, setPointer };
}

/**
 * Permiso para ESCRIBIR sobre un documento. Mismo criterio que los hilos de comentarios
 * (`doc-threads.server.ts:36`), la co-edición (`collab.ts:74`) y las invitaciones.
 *
 * ⚠️ Las dos funciones de guardado NO lo comprobaban: sólo exigían sesión. O sea que
 * cualquiera con cuenta en el workspace podía sobrescribir el documento de un room privado
 * ajeno sabiendo su `documentId` — el mismo agujero que ya se cerró en el export, que hoy
 * responde 404 sin permiso.
 */
async function requireDocEdit(documentId: string, sub: string, isOwner: boolean): Promise<void> {
  const { resolveDocRole } = await import("./doc-access.server");
  const role = await resolveDocRole(documentId, { sub, isOwner });
  if (!role) throw new Error("sin acceso a ese documento");
  if (role !== "edit") throw new Error("sólo puedes leer ese documento");
}

/**
 * Prender o apagar la marca de un documento desde el panel.
 *
 * Existe porque un flag que sólo el agente puede poner es media función: quien recibe el
 * oficio ya hecho tiene que poder quitarle el membrete sin volver a pedírselo al agente.
 *
 * ⚠️ Reescribe la ÚLTIMA versión en sitio (`overwriteArtifactMd`) en vez de publicar una
 * nueva: cambiar el papel no es una edición del contenido, y publicar una versión por cada
 * clic llenaría el historial de entradas idénticas y gastaría el tope de 20 que se guardan.
 * El resto del sobre se hereda, que es justo para lo que existe `previo`.
 */
export const setDocUnbrandedFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; unbranded: boolean }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    // El mismo permiso que editarlo: quien no puede cambiar el texto tampoco el papel.
    await requireDocEdit(data.documentId, me.sub, !!me.isOwner);

    const db = await import("../db.server");
    const ultima = await db.latestDocVersion(data.documentId);
    if (!ultima) throw new Error("ese documento no existe");
    const { parseDocEnvelope, serializeDocEnvelope } = await import("../lib/doc-blocks");
    const previo = parseDocEnvelope(ultima.md);
    // Una fila legacy (markdown pelado, sin sobre) no se puede marcar sin convertirla, y
    // convertirla aquí le cambiaría los uuid a todos los bloques. Se dice en vez de hacerlo.
    if (!previo?.blocks?.length) throw new Error("este documento es de un formato viejo: ábrelo y guárdalo una vez");
    await db.overwriteArtifactMd(
      ultima.id,
      serializeDocEnvelope({
        blocks: previo.blocks,
        humanEdited: previo.humanEdited,
        changedIds: previo.changedIds,
        previo,
        // Explícito, para poder APAGARLO: `previo` sólo hereda cuando esto es `undefined`.
        unbranded: data.unbranded,
      }),
    );
    return { ok: true as const, unbranded: data.unbranded };
  });

export const updateDocBlocksFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; blocks: unknown[]; messageId?: number; title?: string }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    console.log(
      `[fn updateDocBlocks] doc=${data.documentId} msg=${data.messageId ?? "?"} bloques=${
        Array.isArray(data.blocks) ? data.blocks.length : "?"
      } user=${me?.sub ?? "anon"}`,
    );
    if (!me) throw new Error("no autenticado");
    if (!Array.isArray(data.blocks) || !data.blocks.length) throw new Error("documento vacío");
    await requireDocEdit(data.documentId, me.sub, !!me.isOwner);

    const { messageId, avisar, setPointer } = await docSurface(data.documentId, data.messageId, me.sub);

    // El markdown del `md` es para el export y para lo que el agente lee después; la
    // verdad son los `blocks` que van aparte.
    const blocks = data.blocks as import("../lib/doc-blocks").DocBlock[];
    const { blocksToMd } = await import("./doc-blocks.server");
    const md = await blocksToMd(blocks).catch(() => "");

    // Guardados humanos CONSECUTIVOS se escriben encima de la misma versión. Sin esto,
    // cada autoguardado inserta una fila y `pruneArtifactVersions` (20) se comía las
    // versiones del agente en un minuto de tecleo — que es la razón por la que el
    // autosave tenía un techo de una por minuto y la persona podía estar escribiendo
    // 60s sin ver ninguna señal de guardado. La primera edición tras un turno del agente
    // SÍ crea versión: así el trabajo del agente queda como punto al que volver.
    const db = await import("../db.server");
    const ultima = await db.latestDocVersion(data.documentId).catch(() => null);
    console.log(
      `[fn updateDocBlocks] md=${md.length}c ultima=${ultima?.id ?? "ninguna"} humanEdited=${
        ultima?.humanEdited ?? "?"
      } rama=${ultima?.humanEdited ? "overwrite" : "publish"} ini=${JSON.stringify(md.slice(0, 90))}`,
    );
    if (ultima?.humanEdited) {
      const { serializeDocEnvelope, parseDocEnvelope } = await import("../lib/doc-blocks");
      // Hereda del sobre que está PISANDO. Sin esto, guardar en el editor tiraba `sourceMd`
      // y la marca del documento: el oficio sin membrete volvía a llevarlo en cuanto
      // alguien le corregía una coma.
      await db.overwriteArtifactMd(
        ultima.id,
        serializeDocEnvelope({ blocks, humanEdited: true, previo: parseDocEnvelope(ultima.md) }),
      );
      await avisar();
      return { ok: true as const, versionId: ultima.id };
    }

    const { versionId } = await publishArtifactVersion({
      messageId,
      documentId: data.documentId,
      kind: "doc",
      title: data.title ?? "Documento",
      md,
      blocks,
      humanEdited: true,
      ownerSub: me.sub,
      setPointer,
      notify: () => void avisar(),
    });
    // El id se toma de lo que devolvió el INSERT, NUNCA de un `latestDocVersion` posterior:
    // una publicación concurrente devolvería la fila de otro y el editor se fijaría a un
    // documento que no está mirando — justo el bug que esto viene a cerrar.
    return { ok: true as const, versionId };
  });

export const updateArtifactHtmlFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; html: string; messageId: number; title?: string }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    await requireDocEdit(data.documentId, me.sub, !!me.isOwner);

    const { messageId, avisar, setPointer } = await docSurface(data.documentId, data.messageId, me.sub);

    // MISMO camino que el agente (publishArtifactVersion): estampa data-id, publica a
    // storage, INSERT de versión, puntero del hilo y refresh. Antes esto era una copia
    // literal del bloque de chat.ts y las dos ramas se iban separando.
    const { src } = await publishArtifactVersion({
      messageId,
      documentId: data.documentId,
      kind: "artifact",
      title: data.title ?? "Artefacto",
      md: data.html,
      ownerSub: me.sub,
      setPointer,
      notify: () => void avisar(),
    });
    return { ok: true as const, src };
  });

/**
 * RESTAURAR una versión anterior: publica su contenido como versión NUEVA.
 *
 * No borra nada —la 4 y la 5 siguen ahí— así que la propia restauración es reversible y el
 * historial queda honesto. Es lo que hacen Docs y Notion, y lo que evita que un clic mal
 * dado sea irrecuperable con una poda de 20 versiones y sin papelera.
 *
 * Sale de una demo: el historial listaba cinco versiones, ninguna respondía al clic, y la
 * lectura del usuario fue "las versiones son ficticias". El contenido siempre estuvo ahí;
 * lo que faltaba era la forma de llegar a él.
 */
export const restoreArtifactVersionFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; versionId: number; messageId?: number }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");
    await requireDocEdit(data.documentId, me.sub, !!me.isOwner);

    const db = await import("../db.server");

    // ⚠️ `getArtifactVersion(id)` NO filtra por documento: es un SELECT por id a secas. Sin
    // este paso, un id de OTRO documento se restauraría sobre éste. Se comprueba que la
    // versión pedida esté en la lista de ESTE documento antes de leerla — mismo orden que
    // `resolveExportDoc`, que es donde este cuidado ya estaba resuelto.
    const versiones = await db.listArtifactVersions(data.documentId);
    if (!versiones.some((v) => v.id === data.versionId)) {
      throw new Error("esa versión no es de este documento");
    }
    // Restaurar la que ya está viva no es un error, pero tampoco es nada: evita ensuciar el
    // historial con una versión idéntica a la anterior.
    if (versiones[versiones.length - 1]?.id === data.versionId) {
      return { ok: true as const, versionId: data.versionId, sinCambios: true as const };
    }

    const vieja = await db.getArtifactVersion(data.versionId);
    if (!vieja?.md) throw new Error("esa versión ya no tiene contenido");

    const kind = (await db.getDoc(data.documentId))?.kind ?? "doc";
    const { messageId, avisar, setPointer } = await docSurface(data.documentId, data.messageId, me.sub);

    const comun = {
      messageId,
      documentId: data.documentId,
      title: vieja.title ?? (kind === "artifact" ? "Artefacto" : "Documento"),
      ownerSub: me.sub,
      // Quién restauró, para que el historial lo diga.
      authors: [me.sub],
      setPointer,
      notify: () => void avisar(),
    };

    if (kind === "doc") {
      // ⚠️ Se pasan los BLOQUES del sobre, nunca el markdown. Dejar que se re-derive del md
      // haría `docEnvelopeFromMd`, que **cambia el uuid de todos los bloques**: el documento
      // restaurado perdería sus direcciones y con ellas el parcheo del agente, el corrector
      // y el marcado de cambios.
      const { parseDocEnvelope } = await import("../lib/doc-blocks");
      const env = parseDocEnvelope(vieja.md);
      if (!env?.blocks?.length) throw new Error("esa versión no se puede restaurar (sin bloques)");
      const { blocksToMd } = await import("./doc-blocks.server");
      const { versionId } = await publishArtifactVersion({
        ...comun,
        kind: "doc",
        md: await blocksToMd(env.blocks).catch(() => ""),
        blocks: env.blocks,
        // Se hereda del sobre RESTAURADO, no de la última versión: restaurar es volver a
        // ESE documento, marca incluida. `Heredable` deja fuera `humanEdited`, que es lo
        // único que aquí no se puede arrastrar (ver el aviso de abajo).
        previo: env,
        // ⚠️⚠️ SIN `humanEdited`. Si naciera `true`, el primer autoguardado siguiente entra
        // en la rama `overwrite` de arriba y **sobrescribe la fila restaurada en sitio**: el
        // punto de restauración desaparecería del historial. En `false`, el siguiente tecleo
        // crea versión nueva y la restauración se queda como marcador al que volver — el
        // mismo razonamiento por el que la primera edición tras un turno del agente sí crea
        // versión.
      });
      return { ok: true as const, versionId };
    }

    // Artefacto HTML: el `md` guardado ya viene estampado y con Tailwind horneado, así que
    // `stamp: false` lo republica tal cual. Se sube un objeto de storage NUEVO a propósito:
    // si compartiera `src` con la fila original, podar la original mataría el objeto que
    // ésta referencia.
    const { versionId } = await publishArtifactVersion({
      ...comun,
      kind: kind === "sheet" ? "sheet" : "artifact",
      md: vieja.md,
      ...(kind === "artifact" ? { stamp: false as const } : {}),
    });
    return { ok: true as const, versionId };
  });
