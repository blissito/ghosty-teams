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
}): Promise<{ md: string; src: string | null }> {
  const db = await import("../db.server");
  const t0 = performance.now();

  // Solo el HTML tiene nodos que direccionar; doc/sheet son markdown/CSV.
  let md = args.md;
  if (args.kind === "artifact") {
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
      md = await bakeTailwind(md);
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

  await db.createArtifact(args.messageId, {
    kind: args.kind,
    url: args.documentId,
    title: args.title,
    md,
    src,
    ownerSub: args.ownerSub ?? null,
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
  return { md, src };
}

/**
 * La key del bucket a partir del `src` guardado. Hay DOS formas de link vivas —el
 * branded `<base>/<uuid>-name.html` (sin el prefijo interno) y la URL firmada con
 * `t3/` y query— así que lo estable es el último segmento del path.
 */
function storageKeyFromSrc(src: string): string | null {
  const path = src.split("?")[0];
  const name = path.split("/").filter(Boolean).pop();
  return name && /\.html$/i.test(name) ? `t3/${name}` : null;
}

// ── Compartir ───────────────────────────────────────────────────────────────────
// El estado de compartir es del DOCUMENTO, no de la versión: vive en la fila RAÍZ
// (la más vieja del mismo documentId) porque cada publicación inserta una fila nueva.
// Dos estados nada más: "private" (sólo el dueño) y "link" (cualquiera con el link).

export type ArtifactShare = {
  slug: string | null;
  visibility: "private" | "link";
  /** id de la versión congelada; null = Latest (sigue lo último que se publique). */
  sharedArtifactId: number | null;
  versions: { id: number; label: string; createdAt: number }[];
  owner: { sub: string | null; name: string | null; email: string | null; avatar: string | null };
  isOwner: boolean;
};

// El dueño manda: sólo él ve y cambia los permisos. Si la raíz no trae owner_sub
// (artefactos anteriores a esta feature) se cae al autor del mensaje ancla, que es
// lo que ya usaba el scope de lectura de documents.ts.
async function requireShareOwner(documentId: string) {
  const { sessionUser } = await import("./chat");
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  const db = await import("../db.server");
  const root = await db.shareRootFor(documentId);
  if (!root) throw new Error("artefacto no encontrado");
  if (root.ownerSub && root.ownerSub !== me.sub) throw new Error("no eres el dueño de este artefacto");
  return { me, root, db };
}

async function shareStateFor(documentId: string, meSub: string | null): Promise<ArtifactShare | null> {
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
  return {
    slug: root.slug,
    visibility: root.visibility,
    sharedArtifactId: root.sharedArtifactId,
    versions: versions.map((v, i) => ({ id: v.id, label: `Versión ${i + 1}`, createdAt: v.createdAt })),
    owner,
    // Sin owner_sub (artefacto viejo) cualquiera del workspace que lo vea puede
    // adoptarlo: es preferible a dejarlo sin dueño y por tanto incompartible.
    isOwner: !root.ownerSub || root.ownerSub === meSub,
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
    return await shareStateFor(data.documentId, me.sub);
  });

export const setArtifactShareFn = createServerFn({ method: "POST" })
  .validator(
    (d: { documentId: string; visibility?: "private" | "link"; sharedArtifactId?: number | null }) => d
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
    return await shareStateFor(data.documentId, me.sub);
  });

// Guardado de artefactos HTML editados desde el Canvas (editor @ghosty/canvas-editor)
// en el ArtifactPanel. Camino GEMELO al que usa el agente en chat.ts al cerrar un
// eb-doc kind:"artifact": publica el HTML a storage (link compartible) y escribe una
// NUEVA versión en gc_artifacts (INSERT = versión nueva; getDoc toma la última). No
// pasa por el agente — es una edición humana directa sobre el mismo documentId.
export const updateArtifactHtmlFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string; html: string; messageId: number; title?: string }) => d)
  .handler(async ({ data }) => {
    const { sessionUser } = await import("./chat");
    const me = await sessionUser();
    if (!me) throw new Error("no autenticado");

    const { dbq, num } = await import("../dbq.server");

    // Resolver el message_id que ancla el artefacto. El cliente propaga el messageId
    // del ArtifactView; si falta (o es inválido), fallback robusto = la última fila de
    // gc_artifacts con este documentId (todas las versiones cuelgan del mismo mensaje).
    let messageId = data.messageId;
    if (!messageId || messageId <= 0) {
      const rows = await dbq(
        `SELECT message_id FROM gc_artifacts WHERE url = ? ORDER BY id DESC LIMIT 1`,
        [data.documentId]
      );
      messageId = num(rows[0]?.message_id);
    }
    if (!messageId) throw new Error("no se encontró el mensaje del artefacto");

    // Canal/hilo del mensaje ancla (para el puntero del hilo y el refresh del room).
    const rows = await dbq(`SELECT channel_id, parent_id FROM gc_messages WHERE id = ?`, [messageId]);
    const channelId = num(rows[0]?.channel_id);
    const parentId = rows[0]?.parent_id != null ? num(rows[0].parent_id) : null;
    if (!channelId) throw new Error("no se encontró el canal del artefacto");

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
      setPointer: async (docId) => {
        const db = await import("../db.server");
        await db.setThreadArtifact(channelId, parentId, docId);
      },
      notify: async () => {
        const bus = await import("./bus.server");
        const { currentNamespace } = await import("./tenant.server");
        bus.publish(bus.ch.room(await currentNamespace(), channelId), { t: "refresh", channelId, parentId });
      },
    });
    return { ok: true as const, src };
  });
