import { createServerFn } from "@tanstack/react-start";

// Puente colab del artefacto nativo de GTeams. Resuelve la conexión Yjs de un doc y
// persiste su snapshot — todo server-to-server contra EasyBits (evita CORS del browser
// cross-origin). El WS (browser → sync server) sí va directo; sólo el HTTP pasa por aquí.
//
// Hoy el sync server = box `collab-svc` de EasyBits (vía /api/v2/collab/:token/room).
// Al mover a sidecar del team VM, sólo cambia la resolución del wsUrl (misma interfaz).

const GTEAMS_ORIGIN = process.env.GTEAMS_PUBLIC_ORIGIN ?? "https://teams.formmy.app";

// El token de edición vive en la URL del embed/collab que mintea EasyBits.
function extractToken(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/(?:collab\/)?document\/([^/?#]+)/);
  return m ? m[1] : null;
}

// Sesión → sólo miembros del team pueden abrir el editor.
async function requireUser() {
  const { useSession } = await import("@tanstack/react-start/server");
  const { sessionConfig } = await import("./session.server");
  const s = await useSession<{ user?: { sub: string } }>(sessionConfig());
  if (!s.data.user) throw new Error("no autorizado");
  return s.data.user;
}

export type CollabConn = {
  wsUrl: string;
  room: string;
  token: string;
  title: string;
  initialHtml: string;
  persistSectionId: string;
};

// Resuelve {wsUrl, room, token, initialHtml} para montar el editor nativo.
export const docCollabConnFn = createServerFn({ method: "POST" })
  .validator((d: { documentId: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; conn: CollabConn } | { ok: false; error: string }> => {
    await requireUser();
    const { ebFetch } = await import("./easybits-files.server");

    // 1) Mint del link de edición embebible (token de share con perm=edit).
    const embedRes = await ebFetch(`/api/v2/documents/collab-embed-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: data.documentId, origin: GTEAMS_ORIGIN }),
    });
    if (!embedRes.ok) return { ok: false, error: `collab-embed-link ${embedRes.status}` };
    const embed = (await embedRes.json()) as {
      ok?: boolean; title?: string; embedUrl?: string; collabUrl?: string;
    };
    const token = extractToken(embed.collabUrl || embed.embedUrl);
    if (!embed.ok || !token) return { ok: false, error: "sin token de colaboración" };

    // 2) Resuelve el wsUrl del sync server. Preferimos el SIDECAR co-locado en este team
    // VM (`COLLAB_SIDECAR_WS_URL` inyectado al provisionar, = wss://sb-<uuid>-9400…): el
    // sidecar corre collab-svc verbatim, así que room = documentName = landingId y auth =
    // el mismo share token. Sin el env (antes del rollout) caemos al box collab-svc de
    // EasyBits (/room) — mismo contrato, degrada elegante.
    let wsUrl: string;
    let room: string;
    const sidecar = process.env.COLLAB_SIDECAR_WS_URL?.replace(/\/$/, "");
    if (sidecar) {
      wsUrl = sidecar;
      room = data.documentId;
    } else {
      const roomRes = await ebFetch(`/api/v2/collab/${encodeURIComponent(token)}/room`, { method: "GET" });
      if (!roomRes.ok) return { ok: false, error: `collab/room ${roomRes.status}` };
      const r = (await roomRes.json()) as { wsUrl?: string; room?: string };
      if (!r.wsUrl || !r.room) return { ok: false, error: "sin wsUrl" };
      wsUrl = r.wsUrl;
      room = r.room;
    }

    // 3) initialHtml (secciones actuales) para sembrar un doc nuevo.
    let initialHtml = "<p></p>";
    let persistSectionId = "page-1";
    const docRes = await ebFetch(`/api/v2/documents/${encodeURIComponent(data.documentId)}`, { method: "GET" });
    if (docRes.ok) {
      const j = (await docRes.json()) as {
        sections?: Array<{ id?: string; html?: string }>;
        landing?: { sections?: Array<{ id?: string; html?: string }> };
      };
      const secs = ((j.landing ?? j).sections ?? []).filter((s) => s && s.id !== "__grapes_css__" && s.html);
      initialHtml = secs.map((s) => s.html).join("\n") || "<p></p>";
      persistSectionId = secs[0]?.id ?? "page-1";
    }

    return {
      ok: true,
      conn: { wsUrl, room, token, title: embed.title ?? "Documento", initialHtml, persistSectionId },
    };
  });

// Persiste el snapshot HTML del editor a Landing.sections (auth por el share token en la URL).
export const persistDocSectionFn = createServerFn({ method: "POST" })
  .validator((d: { token: string; sectionId: string; html: string; replaceAll?: boolean }) => d)
  .handler(async ({ data }) => {
    await requireUser();
    const { ebFetch } = await import("./easybits-files.server");
    const res = await ebFetch(`/api/v2/share/documents/${encodeURIComponent(data.token)}/section`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sectionId: data.sectionId, html: data.html, replaceAll: data.replaceAll ?? true }),
    });
    return { ok: res.ok };
  });
