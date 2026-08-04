// Conector Sentry (sentry.io) per-user. Calca el molde de denik.server.ts:
// `ambientContext` es BARATO (lee el meta capturado al conectar, sin round-trip) y
// las capacidades ricas viven en `tools` que el agente invoca on-demand.
//
// El token de Sentry NUNCA sale de Teams: la caja del agente sólo tiene un
// tool-token HMAC de 15 min con su `sub` firmado, y los handlers de aquí corren
// en el servidor de Teams.
import { getValidToken } from "./oauth.server";
import { getConnectorRow } from "./store.server";
import type { ConnectorTool } from "./impl";

const BASE = (process.env.SENTRY_BASE_URL ?? "https://sentry.io").replace(/\/$/, "");

type SentryOrg = { id: string | null; slug: string | null; name: string | null };
type SentryMeta = { orgs?: SentryOrg[] };

async function readMeta(sub: string): Promise<SentryMeta | null> {
  const row = await getConnectorRow(sub, "sentry");
  if (!row?.access_token || !row.meta) return null;
  try {
    return JSON.parse(row.meta) as SentryMeta;
  } catch {
    return null;
  }
}

/**
 * Llamada a la API de Sentry con el token del usuario.
 *
 * Los errores se traducen a español accionable en vez de propagar el status:
 * lo que devuelve esta función se lo lee el MODELO, y "403" lo lleva a inventar
 * excusas, mientras que "está en otra organización" lo lleva a decirle al
 * usuario exactamente qué pasó.
 */
async function api(sub: string, path: string, init?: RequestInit): Promise<unknown> {
  const token = await getValidToken(sub, "sentry");
  if (!token) {
    return { error: "La cuenta de Sentry no está conectada. Conéctala en Ajustes → Integraciones." };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/0${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    return { error: `No pude contactar a Sentry: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.ok) return await res.json().catch(() => ({}));

  const body = (await res.text().catch(() => "")).slice(0, 400);
  if (res.status === 401) {
    return { error: "La sesión de Sentry expiró. Pídele que reconecte Sentry en Ajustes → Integraciones." };
  }
  if (res.status === 403) {
    // El token de Sentry vive dentro de UNA organización, así que un 403 casi
    // siempre significa "ese proyecto es de otra org", no "falta un permiso".
    // Colapsarlos en un solo mensaje mandaba al modelo a pedir reconexiones
    // inútiles.
    return {
      error:
        "Sin acceso. La conexión de Sentry sólo alcanza UNA organización: o ese proyecto pertenece a otra, " +
        "o falta un permiso. Si es de otra organización, tiene que reconectar Sentry en Ajustes → Integraciones " +
        "y elegirla al autorizar.",
    };
  }
  if (res.status === 404) return { error: "No encontrado en Sentry (¿el slug del proyecto o el id del issue?)." };
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    return { error: `Sentry está limitando las peticiones${retry ? `; reintenta en ${retry}s` : ""}.` };
  }
  return { error: `Sentry respondió ${res.status}: ${body}` };
}

const qs = (args: Record<string, unknown>, keys: string[]): string => {
  const p = new URLSearchParams();
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Slug de la organización: el que pidan, o el único que alcanza el token. */
async function orgOf(sub: string, args: Record<string, unknown>): Promise<string | null> {
  if (typeof args.org === "string" && args.org) return args.org;
  const meta = await readMeta(sub);
  return meta?.orgs?.[0]?.slug ?? null;
}

const NO_ORG = {
  error:
    "No sé de qué organización de Sentry hablar. Pásale `org` (el slug), o pídele que reconecte Sentry en " +
    "Ajustes → Integraciones.",
};

// ── Poda de eventos ──────────────────────────────────────────────────────────
// Un evento crudo de Sentry son decenas de KB (todos los marcos de todas las
// librerías, con su `context_line` y sus `vars`) y entra ENTERO al contexto del
// turno. Una sola llamada sin podar se come la ventana, así que aquí se recorta
// a lo que de verdad sirve para diagnosticar: los marcos `in_app`, sin variables
// locales, y los últimos primero (el más cercano al fallo).

const MAX_FRAMES = 25;

function trimFrames(frames: any[]): unknown[] {
  const inApp = frames.filter((f) => f?.in_app);
  // Si nada está marcado in_app (SDKs mal configurados) es preferible dar los
  // últimos marcos que devolver una lista vacía y que el modelo diga "no hay
  // stacktrace" teniéndolo delante.
  const useful = inApp.length ? inApp : frames;
  return useful.slice(-MAX_FRAMES).map((f) => ({
    filename: f?.filename ?? f?.abs_path ?? null,
    function: f?.function ?? null,
    lineNo: f?.lineno ?? null,
    colNo: f?.colno ?? null,
    context: f?.context_line ?? null,
    inApp: f?.in_app === true,
  }));
}

function trimEvent(ev: any): unknown {
  if (!ev || typeof ev !== "object" || "error" in ev) return ev;
  const entries: any[] = Array.isArray(ev.entries) ? ev.entries : [];
  const exception = entries.find((e) => e?.type === "exception");
  const values: any[] = exception?.data?.values ?? [];
  const breadcrumbs = entries.find((e) => e?.type === "breadcrumbs")?.data?.values ?? [];

  return {
    id: ev.id ?? null,
    title: ev.title ?? null,
    message: ev.message ?? null,
    dateCreated: ev.dateCreated ?? null,
    platform: ev.platform ?? null,
    tags: Array.isArray(ev.tags) ? ev.tags.map((t: any) => ({ key: t?.key, value: t?.value })) : [],
    user: ev.user ? { id: ev.user.id ?? null, email: ev.user.email ?? null } : null,
    exceptions: values.map((v) => ({
      type: v?.type ?? null,
      value: v?.value ?? null,
      frames: trimFrames(Array.isArray(v?.stacktrace?.frames) ? v.stacktrace.frames : []),
    })),
    breadcrumbs: (Array.isArray(breadcrumbs) ? breadcrumbs : []).slice(-15).map((b: any) => ({
      category: b?.category ?? null,
      level: b?.level ?? null,
      message: b?.message ?? null,
      timestamp: b?.timestamp ?? null,
    })),
  };
}

function trimIssue(i: any): unknown {
  if (!i || typeof i !== "object" || "error" in i) return i;
  return {
    id: i.id ?? null,
    shortId: i.shortId ?? null,
    title: i.title ?? null,
    culprit: i.culprit ?? null,
    level: i.level ?? null,
    status: i.status ?? null,
    substatus: i.substatus ?? null,
    count: i.count ?? null,
    userCount: i.userCount ?? null,
    firstSeen: i.firstSeen ?? null,
    lastSeen: i.lastSeen ?? null,
    permalink: i.permalink ?? null,
    project: i.project ? { slug: i.project.slug ?? null, name: i.project.name ?? null } : null,
    assignedTo: i.assignedTo ? { type: i.assignedTo.type ?? null, name: i.assignedTo.name ?? null } : null,
  };
}

// ── Contexto ambiente ────────────────────────────────────────────────────────

export async function ambientContext(sub: string, sender: string, _message: string): Promise<string | null> {
  const meta = await readMeta(sub);
  if (!meta) return null;

  const orgs = meta.orgs ?? [];
  const orgList = orgs.length
    ? orgs.map((o) => `${o.name ?? o.slug} (slug: ${o.slug})`).join(", ")
    : "sin organizaciones visibles";

  return (
    `[INTEGRACIÓN Sentry de ${sender} (conectada). Organización: ${orgList}. ` +
    `TIENES HERRAMIENTAS para sus errores vía el GS Tools SDK: importa /opt/gs-sdk/connectors.mjs y usa ` +
    `list() y run(name, args). Tools: sentry_list_projects, sentry_list_issues, sentry_get_issue, ` +
    `sentry_issue_latest_event, sentry_update_issue, sentry_list_releases, sentry_project_stats. ` +
    `Para CUALQUIER pregunta sobre errores, excepciones, crashes o releases de ${sender}, USA estas tools — ` +
    `NO inventes datos ni digas que no tienes acceso (SÍ lo tienes). El slug del proyecto sale de ` +
    `sentry_list_projects. Para diagnosticar de verdad un error necesitas el STACKTRACE: ` +
    `sentry_issue_latest_event, no sólo sentry_get_issue. ` +
    `IMPORTANTE: la conexión alcanza SÓLO la organización de arriba; si un proyecto no aparece, ` +
    `probablemente está en otra y hay que reconectar eligiéndola, no es que no exista. ` +
    `sentry_update_issue MODIFICA el issue (resolver, ignorar, asignar): confirma con ${sender} antes de usarla.]`
  );
}

// ── Tools ────────────────────────────────────────────────────────────────────

const str = (description: string) => ({ type: "string", description });
const orgProp = {
  org: str("Slug de la organización. Omítelo para usar la de la conexión."),
};

export const tools: ConnectorTool[] = [
  {
    name: "sentry_list_projects",
    description:
      "Lista los proyectos de la organización con su slug y plataforma. El slug de aquí es lo que necesitan las demás tools.",
    inputSchema: { type: "object", properties: { ...orgProp } },
    handler: async (sub, a) => {
      const org = await orgOf(sub, a);
      if (!org) return NO_ORG;
      const r = await api(sub, `/organizations/${encodeURIComponent(org)}/projects/`);
      if (!Array.isArray(r)) return r;
      return r.map((p: any) => ({
        slug: p?.slug ?? null,
        name: p?.name ?? null,
        platform: p?.platform ?? null,
        lastEvent: p?.firstEvent ?? null,
      }));
    },
  },
  {
    name: "sentry_list_issues",
    description:
      "Issues (errores agrupados) de un proyecto, del más reciente al más viejo. Es la forma correcta de responder '¿qué está fallando?'. Por default trae los sin resolver.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgProp,
        project: str("Slug del proyecto (de sentry_list_projects)."),
        query: str(
          'Búsqueda estilo Sentry. Default "is:unresolved". Ejemplos: "is:unresolved level:error", "release:1.2.3".',
        ),
        statsPeriod: str("Ventana de tiempo: 24h, 14d, 90d. Default 14d."),
        limit: { type: "number", description: "Cuántos devolver (1-100, default 25)." },
      },
      required: ["project"],
    },
    handler: async (sub, a) => {
      const org = await orgOf(sub, a);
      if (!org) return NO_ORG;
      const p = encodeURIComponent(String(a.project));
      const r = await api(
        sub,
        `/projects/${encodeURIComponent(org)}/${p}/issues/` +
          qs(
            {
              query: a.query ?? "is:unresolved",
              statsPeriod: a.statsPeriod ?? "14d",
              limit: a.limit ?? 25,
            },
            ["query", "statsPeriod", "limit"],
          ),
      );
      return Array.isArray(r) ? r.map(trimIssue) : r;
    },
  },
  {
    name: "sentry_get_issue",
    description:
      "Detalle de un issue por su id: cuántas veces ocurrió, a cuántos usuarios afectó, desde cuándo y a quién está asignado. Para el stacktrace usa sentry_issue_latest_event.",
    inputSchema: {
      type: "object",
      properties: { issueId: str("Id numérico o shortId del issue.") },
      required: ["issueId"],
    },
    handler: async (sub, a) => trimIssue(await api(sub, `/issues/${encodeURIComponent(String(a.issueId))}/`)),
  },
  {
    name: "sentry_issue_latest_event",
    description:
      "El evento más reciente de un issue CON SU STACKTRACE, tags, usuario afectado y breadcrumbs. Es lo que sirve para diagnosticar la causa. Los marcos vienen podados a los del código propio.",
    inputSchema: {
      type: "object",
      properties: { issueId: str("Id numérico o shortId del issue.") },
      required: ["issueId"],
    },
    handler: async (sub, a) =>
      trimEvent(await api(sub, `/issues/${encodeURIComponent(String(a.issueId))}/events/latest/`)),
  },
  {
    name: "sentry_update_issue",
    description:
      "MODIFICA un issue: resolverlo, ignorarlo, reabrirlo o asignarlo. Confirma con el usuario antes de usarla.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: str("Id numérico o shortId del issue."),
        status: str("resolved | ignored | unresolved | resolvedInNextRelease."),
        assignedTo: str('A quién asignar: "user:<id>", "team:<id>" o el correo. Vacío para desasignar.'),
      },
      required: ["issueId"],
    },
    handler: async (sub, a) => {
      const body: Record<string, unknown> = {};
      if (typeof a.status === "string" && a.status) body.status = a.status;
      if (typeof a.assignedTo === "string") body.assignedTo = a.assignedTo;
      if (!Object.keys(body).length) return { error: "Nada que cambiar: pasa `status` o `assignedTo`." };
      return trimIssue(
        await api(sub, `/issues/${encodeURIComponent(String(a.issueId))}/`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      );
    },
  },
  {
    name: "sentry_list_releases",
    description:
      "Releases de la organización, de la más reciente hacia atrás, con su fecha y los proyectos que la usan. Sirve para saber si un error apareció con un despliegue.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgProp,
        project: str("Limita a un proyecto (slug)."),
        query: str("Filtra por versión."),
        limit: { type: "number", description: "1-100, default 20." },
      },
    },
    handler: async (sub, a) => {
      const org = await orgOf(sub, a);
      if (!org) return NO_ORG;
      const r = await api(
        sub,
        `/organizations/${encodeURIComponent(org)}/releases/` +
          qs({ ...a, per_page: a.limit ?? 20 }, ["project", "query", "per_page"]),
      );
      if (!Array.isArray(r)) return r;
      return r.map((x: any) => ({
        version: x?.version ?? null,
        shortVersion: x?.shortVersion ?? null,
        dateCreated: x?.dateCreated ?? null,
        dateReleased: x?.dateReleased ?? null,
        newGroups: x?.newGroups ?? null,
        projects: Array.isArray(x?.projects) ? x.projects.map((p: any) => p?.slug) : [],
      }));
    },
  },
  {
    name: "sentry_project_stats",
    description:
      "Serie de conteo de eventos de un proyecto en el tiempo. Sirve para responder '¿estamos peor que ayer?' o para ver un pico.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgProp,
        project: str("Slug del proyecto."),
        stat: str("received | rejected | blacklisted. Default received."),
        resolution: str("Granularidad: 10s, 1h o 1d. Default 1h."),
      },
      required: ["project"],
    },
    handler: async (sub, a) => {
      const org = await orgOf(sub, a);
      if (!org) return NO_ORG;
      const p = encodeURIComponent(String(a.project));
      const r = await api(
        sub,
        `/projects/${encodeURIComponent(org)}/${p}/stats/` +
          qs({ stat: a.stat ?? "received", resolution: a.resolution ?? "1h" }, ["stat", "resolution"]),
      );
      // Sentry devuelve [[epochSecs, count], …]; se etiqueta para que el modelo no
      // tenga que adivinar cuál columna es cuál.
      if (!Array.isArray(r)) return r;
      return r.map((pair: any) => ({
        at: Array.isArray(pair) ? new Date(pair[0] * 1000).toISOString() : null,
        count: Array.isArray(pair) ? pair[1] : null,
      }));
    },
  },
];
