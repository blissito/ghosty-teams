import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "../chat";
import type { ProposalEdit } from "./ads-proposal";

// Ghosty Ads: campañas de Meta que llevan a Messenger, desde un room con `@ads`.
//
// Instalar (Ajustes → Apps, sólo el dueño) deja:
//  1. un room (uno existente o `#anuncios`) donde vive `@ads`;
//  2. el handle `@ads` apuntando a un agente de Studio que elige el dueño (la app NO crea
//     agentes: mismo mecanismo que los roles de la Fábrica);
//  3. el reporte automático de las 9:00 y 21:00 (CDMX);
//  4. la fila en `gt_installed_apps`, que es lo que hace aparecer las tools `ads_*`.
// La credencial de Meta la guarda gs: «Conectar Meta» abre su OAuth en otra pestaña.
// Desinstalar apaga `@ads` y sus tools; las campañas y Meta no se tocan.

type AdsCfg = {
  roomId?: number;
  agentId?: string;
  /** `@ads` lo creó la instalación: sólo así se repunta o se apaga. */
  ownsHandle?: boolean;
};

const HANDLE = "ads";
const IDP = () => process.env.GHOSTY_IDENTITY_URL ?? "https://www.ghosty.studio";

async function requireOwner() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("sólo el dueño del espacio instala apps");
  return user;
}

async function requireUser() {
  const me = await sessionUser();
  if (!me) throw new Error("no autenticado");
  return me;
}

/**
 * Apunta `@ads` al agente elegido. Crea el handle si no existe; si ya es de la app, lo
 * repunta; si es de OTRA cosa, error. Misma activación «De Studio» que los roles de la Fábrica.
 */
async function assignAdsRole(sub: string, agentId: string, cfg: AdsCfg | null): Promise<{ agentId: string; ownsHandle: boolean }> {
  const { studioAgents } = await import("./factory");
  const agent = (await studioAgents()).find((a) => a.id === agentId);
  if (!agent) throw new Error("elige un agente de Studio (Claude, DeepSeek o Codex) para @ads");
  const db = await import("../../db.server");
  const { dbq } = await import("../../dbq.server");
  const { ADS_ROLE_NAME, adsAvatar } = await import("./ads-role");
  const row = await db.getAgentByHandle(HANDLE);
  if (!row) {
    await db.createAgent({
      handle: HANDLE,
      name: ADS_ROLE_NAME,
      kind: "fleet",
      fleetId: agent.id,
      fleetToken: null,
      runtime: "gs-native",
      groupNs: true,
      avatar: adsAvatar(),
      systemPrompt: null,
      createdBy: sub,
    });
  } else if (cfg?.ownsHandle) {
    await dbq(
      `UPDATE gc_agents SET fleet_id = ?, kind = 'fleet', runtime = 'gs-native', runtime_url = NULL, fleet_token = NULL,
                            enabled = 1, name = ?, avatar = ?, group_ns = 1 WHERE handle = ?`,
      [agent.id, ADS_ROLE_NAME, adsAvatar(), HANDLE],
    );
  } else {
    throw new Error("@ads ya lo usa otro agente de este espacio: renómbralo antes de instalar Ghosty Ads");
  }
  const { connectTeamsChannel } = await import("../agent-config");
  await connectTeamsChannel(agent.id, "", "gs-native").catch(() => {});
  return { agentId: agent.id, ownsHandle: true };
}

export type AdsAppStatus = Awaited<ReturnType<typeof readStatus>>;

async function readStatus() {
  const { getAppConfig } = await import("./installed.server");
  const cfg = await getAppConfig<AdsCfg>("ads");
  const { studioAgents } = await import("./factory");
  const candidates = await studioAgents().catch(() => []);
  const { metaStatus, gsAds } = await import("./ads-gs.server");
  const meta = await metaStatus();
  // Con Meta conectado, las cuentas y páginas para elegir (si hay varias).
  const assets = meta.connected ? await gsAds("assets") : null;
  const { getSchedule } = await import("./ads-report.server");
  const db = await import("../../db.server");
  const ch = cfg?.roomId ? await db.getChannelById(cfg.roomId) : null;
  // La verdad es la fila del handle HOY, no la config.
  const agentId = cfg ? ((await db.listAgents()).find((a) => a.handle === HANDLE && a.enabled)?.fleet_id ?? null) : null;
  const a = candidates.find((c) => c.id === agentId);
  return {
    installed: !!cfg,
    room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null,
    agent: agentId ? { id: agentId, label: a ? `${a.name} · ${a.engine} · ${a.model}` : "agente fuera de la lista", studioUrl: `${IDP()}/app/agents/${agentId}` } : null,
    candidates,
    studioAgentsUrl: `${IDP()}/app/agents`,
    meta,
    assets: assets?.ok ? { adAccounts: assets.adAccounts ?? [], pages: assets.pages ?? [] } : null,
    schedule: cfg ? await getSchedule() : null,
  };
}

export const adsStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireOwner();
  return readStatus();
});

/** ¿Ghosty Ads está instalada? Para la barra lateral: cualquiera con sesión. */
export const adsInstalledFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await sessionUser();
  if (!me) return false;
  const { isInstalled } = await import("./installed.server");
  return await isInstalled("ads").catch(() => false);
});

export const installAdsFn = createServerFn({ method: "POST" })
  .validator((d: { roomId?: number | null; agentId: string }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const db = await import("../../db.server");
    const { getAppConfig, recordInstall } = await import("./installed.server");
    const prev = await getAppConfig<AdsCfg>("ads", { includeUninstalled: true });
    // 1. El rol primero: si el agente no vale, no se crea nada más.
    const role = await assignAdsRole(user.sub, String(data.agentId ?? ""), prev);
    // 2. El room (el que eligió, el de la instalación anterior o `#anuncios` nuevo).
    let roomId = Number(data.roomId) || 0;
    const visible = await db.listChannels(user.sub, true);
    if (roomId) {
      if (!visible.some((c) => c.id === roomId)) throw new Error("room no encontrado");
    } else {
      const ch = await db.createChannel({
        name: "anuncios",
        description: "Ghosty Ads: pídele a @ads una campaña; tú la creas y la prendes desde su tarjeta.",
        isPrivate: false,
        createdBy: user.sub,
      });
      roomId = ch.id;
    }
    // 3. El reporte de las 9:00 y 21:00 (sólo la primera vez: reinstalar respeta lo que se eligió).
    const { getSchedule, saveSchedule } = await import("./ads-report.server");
    const { dbq } = await import("../../dbq.server");
    const hasSchedule = (await dbq("SELECT 1 FROM gt_ads_schedule WHERE id = 1", []).catch(() => [])).length > 0;
    if (!hasSchedule) await saveSchedule({ enabled: true }, user.sub);
    else {
      const s = await getSchedule();
      if (s.enabled) await saveSchedule({ enabled: true, hours: s.hours }, user.sub, s.tz);
    }
    // 4. La fila que enciende las tools.
    await recordInstall("ads", user.sub, { roomId, ...role });
    const ch = await db.getChannelById(roomId);
    return { ok: true as const, room: ch ? { id: ch.id, slug: ch.slug, name: ch.name } : null };
  });

/** Cambia a qué agente apunta `@ads`, sin reinstalar. */
export const setAdsAgentFn = createServerFn({ method: "POST" })
  .validator((d: { agentId: string }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { getAppConfig, recordInstall } = await import("./installed.server");
    const cfg = await getAppConfig<AdsCfg>("ads");
    if (!cfg) throw new Error("Ghosty Ads no está instalada");
    const role = await assignAdsRole(user.sub, String(data.agentId ?? ""), cfg);
    await recordInstall("ads", user.sub, { ...cfg, ...role });
    return { ok: true as const };
  });

export const uninstallAdsFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireOwner();
  const { getAppConfig, recordUninstall } = await import("./installed.server");
  const cfg = await getAppConfig<AdsCfg>("ads");
  // Sólo el handle que creó la app; el agente de Studio no se toca.
  if (cfg?.ownsHandle) {
    const { dbq } = await import("../../dbq.server");
    await dbq("UPDATE gc_agents SET enabled = 0 WHERE handle = ?", [HANDLE]);
  }
  await recordUninstall("ads");
  return { ok: true as const };
});

/** El link firmado de gs al OAuth de Meta (vale 15 min). Vuelve a /ads al terminar. */
export const adsConnectUrlFn = createServerFn({ method: "POST" }).handler(async () => {
  const me = await requireOwner();
  const { reqOrigin } = await import("../../origin.server");
  const origin = await reqOrigin().catch(() => "");
  if (!origin) throw new Error("no pude resolver la dirección de este espacio");
  // gs sólo regresa a https de *.ghosty.studio: desde otro host (local) se dice aquí.
  if (!/^https:\/\/([a-z0-9-]+\.)*ghosty\.studio$/i.test(origin)) throw new Error("conectar Meta sólo funciona desde tu espacio en ghosty.studio");
  const { gsAds } = await import("./ads-gs.server");
  // El correo liga la conexión a la cuenta de gs de quien conectó (su rol en Meta es el que vale).
  // La sesión no siempre trae el correo: si falta, sale del padrón del espacio.
  const db = await import("../../db.server");
  const email = (me as { email?: string | null }).email ?? (await db.emailsForSubsAny([me.sub]).catch(() => []))[0]?.email ?? null;
  const r = await gsAds("connect_url", { returnTo: `${origin}/ads`, email });
  if (!r.ok) throw new Error(r.error);
  return { url: r.url };
});

/** Elegir cuenta de anuncios y página (cuando la persona tiene varias). */
export const adsSelectFn = createServerFn({ method: "POST" })
  .validator((d: { adAccountId: string; pageId: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    if (!data.adAccountId || !data.pageId) throw new Error("elige la cuenta y la página");
    const { gsAds } = await import("./ads-gs.server");
    const r = await gsAds("select", { adAccountId: String(data.adAccountId), pageId: String(data.pageId) });
    if (!r.ok) throw new Error(r.error);
    return { ok: true as const };
  });

// ── Tarjetas ─────────────────────────────────────────────────────────────────

/** La campaña, si quien pregunta ve su room (si no, no existe para él). */
async function visibleCampaign(campaignId: number) {
  const me = await requireUser();
  const C = await import("./ads-campaigns.server");
  const c = await C.getCampaign(Number(campaignId));
  if (!c) return null;
  const db = await import("../../db.server");
  const ch = (await db.listChannels(me.sub, me.isOwner)).find((x) => x.id === c.channelId);
  if (!ch) return null;
  return { me, C, c, ch };
}

async function nameOf(sub: string | null): Promise<string | null> {
  if (!sub) return null;
  const { listWorkspaceUsers } = await import("../../users.server");
  return (await listWorkspaceUsers().catch(() => [])).find((u) => u.sub === sub)?.name ?? null;
}

/** Lo que pinta `gt-ads-proposal`. Se lee al pintar: el estado cambia con los botones. */
export const adsProposalCardFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v) return null;
    const { c, C, ch } = v;
    let previewSrc = c.proposal.previewSrc ?? null;
    let previewNote = c.proposal.previewNote ?? null;
    // Sin vista previa al proponer (gs no contestó): se pide otra vez mientras siga en propuesta.
    if (!previewSrc && !previewNote && c.status === "proposal") {
      const p = await C.forGs(c);
      if (!("error" in p)) {
        const { gsAds } = await import("./ads-gs.server");
        const r = await gsAds("preview", { proposal: p });
        if (r.ok) {
          previewSrc = r.iframeSrc ?? null;
          previewNote = r.note ?? null;
          const { dbq } = await import("../../dbq.server");
          await dbq("UPDATE gt_ads_campaigns SET proposal_json = ? WHERE id = ?", [JSON.stringify({ ...c.proposal, previewSrc, previewNote }), c.id]).catch(() => {});
        }
      }
    }
    const { estimate: _e, previewSrc: _p, previewNote: _n, ...proposal } = c.proposal;
    // Las anteriores, para verlas en sólo lectura (la vigente es la de arriba).
    const versions = await C.listVersions(c.id);
    return {
      campaignId: c.id,
      status: c.status,
      error: c.error,
      proposal,
      estimate: c.proposal.estimate ?? null,
      previewSrc,
      previewNote,
      version: versions[0]?.version ?? 1,
      versions: versions.slice(1),
      /** El mensaje que es la tarjeta de la campaña: si es ésta, al crearse se vuelve la de campaña. */
      cardMsgId: c.cardMsgId,
      title: c.title,
      roomSlug: ch.slug,
      rootMsgId: c.rootMsgId,
      approvedBy: await nameOf(c.approvedBy),
    };
  });

/** La campaña de un hilo (para las líneas «✏️ … → vN» viejas, que no traen el #N). */
export const adsThreadCampaignFn = createServerFn({ method: "POST" })
  .validator((d: { channelId: number; rootId: number }) => d)
  .handler(async ({ data }) => {
    const me = await requireUser();
    const db = await import("../../db.server");
    if (!(await db.listChannels(me.sub, me.isOwner)).some((x) => x.id === Number(data.channelId))) return null;
    const C = await import("./ads-campaigns.server");
    const c = await C.campaignOfThread(Number(data.channelId), Number(data.rootId));
    return c ? c.id : null;
  });

/**
 * El creativo de la campaña para la pestaña «Creativo» del panel: el último artefacto
 * «Creativo · …» publicado en su hilo (lo arma @ads con el brand kit). null si no hay.
 */
export const adsCreativeFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v?.c.rootMsgId) return null;
    const { dbq } = await import("../../dbq.server");
    const rows = await dbq(
      `SELECT a.title, a.md, a.src, a.url, a.message_id FROM gc_artifacts a JOIN gc_messages m ON m.id = a.message_id
       WHERE m.channel_id = ? AND (m.id = ? OR m.parent_id = ?) AND a.kind = 'artifact' AND a.title LIKE 'Creativo%'
         AND a.archived_at IS NULL ORDER BY a.id DESC LIMIT 1`,
      [v.c.channelId, v.c.rootMsgId, v.c.rootMsgId],
    ).catch(() => []);
    const r = rows[0];
    if (!r?.md) return null;
    return { title: String(r.title), html: String(r.md), src: r.src ? String(r.src) : null, documentId: String(r.url), messageId: Number(r.message_id) };
  });

/** Quien edita en la tarjeta: su correo queda en `edited_by`; su nombre, en el hilo. */
async function editorOf(me: { sub: string; name?: string | null }) {
  const db = await import("../../db.server");
  const email = (await db.emailsForSubsAny([me.sub]).catch(() => []))[0]?.email ?? me.sub;
  return { editedBy: email, display: me.name || email };
}

/**
 * Edición en línea de la propuesta (copy, título, saludo, presupuesto, fecha, botón, quitar
 * intereses). Cualquiera que vea el room; sólo en propuesta. Se valida con las reglas de
 * `ads-proposal.ts`, se pide vista previa nueva y queda como versión nueva.
 */
export const adsEditProposalFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number; edit: ProposalEdit }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v) throw new Error("no ves esa campaña");
    const { me, C, c } = v;
    if (c.status !== "proposal") throw new Error("sólo se edita mientras es propuesta");
    const { applyEdit } = await import("./ads-proposal");
    const e = data.edit ?? {};
    const edit: ProposalEdit = {
      ...(e.name != null ? { name: String(e.name) } : {}),
      ...(e.message != null ? { message: String(e.message) } : {}),
      ...(e.headline != null ? { headline: String(e.headline) } : {}),
      ...(e.greeting != null ? { greeting: String(e.greeting) } : {}),
      ...(e.dailyBudget != null ? { dailyBudget: Number(e.dailyBudget) } : {}),
      ...(e.endTime != null ? { endTime: String(e.endTime) } : {}),
      ...(e.cta != null ? { cta: String(e.cta) } : {}),
      ...(Array.isArray(e.removeInterestIds) ? { removeInterestIds: e.removeInterestIds.map(String) } : {}),
      // La segmentación completa: la valida `parseTargeting` dentro de `applyEdit`.
      ...(e.targeting && typeof e.targeting === "object" ? { targeting: e.targeting } : {}),
    };
    const { estimate: _e, previewSrc: _p, previewNote: _n, ...current } = c.proposal;
    const next = applyEdit(current, edit, Date.now());
    if (typeof next === "string") throw new Error(next);
    const r = await C.saveVersion(c, next, await editorOf(me));
    return { ok: true as const, version: r.version, previewError: r.previewError ?? null };
  });

/**
 * Buscadores de la tarjeta (zonas e intereses) para editar la segmentación. Cualquiera que
 * vea el room de la campaña; sólo leen de Meta, por gs.
 */
export const adsTargetingSearchFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number; kind: "locations" | "interests"; q: string }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v) throw new Error("no ves esa campaña");
    const q = String(data.q ?? "").trim().slice(0, 80);
    if (q.length < 2) return { locations: [], interests: [] };
    const { gsAds } = await import("./ads-gs.server");
    if (data.kind === "locations") {
      const r = await gsAds("locations", { q });
      if (!r.ok) throw new Error(r.error);
      return { locations: (r.items ?? []).slice(0, 12), interests: [] };
    }
    const r = await gsAds("interests", { q });
    if (!r.ok) throw new Error(r.error);
    return { locations: [], interests: (r.items ?? []).slice(0, 12) };
  });

/** «Usar esta versión»: copia una versión anterior como versión nueva (vigente). */
export const adsUseVersionFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number; version: number }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v) throw new Error("no ves esa campaña");
    const { me, C, c } = v;
    const old = (await C.listVersions(c.id)).find((x) => x.version === Number(data.version));
    if (!old) throw new Error("esa versión no existe");
    // Se revalida: una fecha de fin que ya pasó no vuelve a ser vigente.
    const { applyEdit } = await import("./ads-proposal");
    const next = applyEdit(old.proposal, {}, Date.now());
    if (typeof next === "string") throw new Error(`la v${old.version} ya no es válida: ${next}`);
    const r = await C.saveVersion(c, next, await editorOf(me));
    return { ok: true as const, version: r.version };
  });

/** Lo que pinta `gt-ads-campaign`: estado y embudo en vivo. */
export const adsCampaignCardFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v) return null;
    const { c, C } = v;
    const { inMeta } = await import("./ads-flow");
    const f = inMeta(c.status) ? await C.funnels([c]) : null;
    return {
      campaignId: c.id,
      title: c.title,
      status: c.status,
      imported: c.imported,
      dailyBudget: c.proposal.dailyBudget ?? null,
      endTime: c.proposal.endTime || null,
      funnel: f?.byId.get(c.id) ?? null,
      funnelError: f?.error ?? null,
      approvedBy: await nameOf(c.approvedBy),
      adsManagerUrl: c.metaCampaignId ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?selected_campaign_ids=${encodeURIComponent(c.metaCampaignId)}` : null,
    };
  });

/** Lo que pinta `gt-ads-report`: el reporte guardado, si quien lo mira ve su room. */
export const adsReportCardFn = createServerFn({ method: "POST" })
  .validator((d: { reportId: number }) => d)
  .handler(async ({ data }) => {
    const me = await requireUser();
    const { getReport } = await import("./ads-report.server");
    const r = await getReport(Number(data.reportId));
    if (!r) return null;
    const db = await import("../../db.server");
    const ch = (await db.listChannels(me.sub, me.isOwner)).find((x) => x.id === r.channelId);
    if (!ch) return null;
    return {
      at: r.data.at,
      items: r.data.items.map((i) => ({ ...i, threadUrl: i.threadId ? `/c/${ch.slug}?thread=${i.threadId}` : null })),
    };
  });

export type AdsAction = "create" | "cancel" | "retry" | "activate" | "pause" | "budget";

/**
 * Los botones de las tarjetas. Pica una PERSONA: se revisa su sesión y que vea el room, el
 * cambio se aplica con guardia, se llama a gs, queda `approved_by` y el hilo lo dice.
 */
export const adsActionFn = createServerFn({ method: "POST" })
  .validator((d: { campaignId: number; action: AdsAction; dailyBudget?: number }) => d)
  .handler(async ({ data }) => {
    const v = await visibleCampaign(Number(data.campaignId));
    if (!v) throw new Error("no ves esa campaña");
    const { me, C, c } = v;
    const who = { sub: me.sub, name: me.name };
    let next;
    switch (data.action) {
      case "create":
        next = await C.createPaused(c, who);
        break;
      case "cancel":
        next = await C.cancelCampaign(c, who);
        break;
      case "retry":
        next = await C.retryCampaign(c);
        break;
      case "activate":
        next = await C.setStatus(c, who, "ACTIVE");
        break;
      case "pause":
        next = await C.setStatus(c, who, "PAUSED");
        break;
      case "budget":
        next = await C.setBudget(c, who, Number(data.dailyBudget));
        break;
      default:
        throw new Error("acción desconocida");
    }
    return { ok: true as const, status: next.status };
  });

// ── La página «Anuncios» (/ads) ──────────────────────────────────────────────

export type AdsCampaignRow = {
  id: number;
  title: string;
  status: string;
  imported: boolean;
  dailyBudget: number | null;
  spend: number | null;
  conversations: number | null;
  qualified: number | null;
  costPerQualified: number | null;
  threadUrl: string | null;
};

/** Lo que ve cualquier miembro en /ads: las campañas de los rooms que ve, con su embudo. */
export const adsOverviewFn = createServerFn({ method: "GET" }).handler(async () => {
  const me = await requireUser();
  const { isInstalled, getAppConfig } = await import("./installed.server");
  const installed = await isInstalled("ads").catch(() => false);
  const cfg = await getAppConfig<AdsCfg>("ads").catch(() => null);
  const db = await import("../../db.server");
  const channels = await db.listChannels(me.sub, me.isOwner);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const room = cfg?.roomId ? (byId.get(cfg.roomId) ?? null) : null;
  const { metaStatus } = await import("./ads-gs.server");
  const meta: Awaited<ReturnType<typeof metaStatus>> = installed ? await metaStatus() : { connected: false, expiresAt: null, adAccount: null, page: null };
  const C = await import("./ads-campaigns.server");
  const cs = installed ? await C.campaignsOf([...byId.keys()]) : [];
  const { inMeta } = await import("./ads-flow");
  // Números sólo de las que existen en Meta (las terminadas también: su gasto ya pasó).
  const { byId: funnels, error } = await C.funnels(cs.filter((c) => inMeta(c.status)));
  const campaigns: AdsCampaignRow[] = cs.map((c) => {
    const f = funnels.get(c.id);
    const ch = byId.get(c.channelId)!;
    const thread = c.rootMsgId ?? c.cardMsgId;
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      imported: c.imported,
      dailyBudget: c.proposal.dailyBudget ?? null,
      spend: f?.spend ?? null,
      conversations: f?.conversations ?? null,
      qualified: f?.qualified ?? null,
      costPerQualified: f?.costPerQualified ?? null,
      threadUrl: thread ? `/c/${ch.slug}?thread=${thread}` : `/c/${ch.slug}`,
    };
  });
  return {
    installed,
    isOwner: !!me.isOwner,
    room: room ? { id: room.id, slug: room.slug, name: room.name } : null,
    meta,
    campaigns,
    funnelError: error,
  };
});

/** Campañas de la cuenta de Meta que todavía no están aquí (para importar). Sólo el dueño. */
export const adsImportableFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireOwner();
  const { gsAds } = await import("./ads-gs.server");
  const r = await gsAds("campaigns");
  if (!r.ok) throw new Error(r.error);
  const { dbq } = await import("../../dbq.server");
  const have = new Set((await dbq("SELECT meta_campaign_id FROM gt_ads_campaigns WHERE meta_campaign_id IS NOT NULL", [])).map((x) => String(x.meta_campaign_id)));
  return (r.items ?? []).filter((i) => !have.has(String(i.id)));
});

/** «Importar campaña existente»: la fila #N en el room de la app, sin tocar Meta. */
export const adsImportFn = createServerFn({ method: "POST" })
  .validator((d: { metaCampaignId: string }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { getAppConfig } = await import("./installed.server");
    const cfg = await getAppConfig<AdsCfg>("ads");
    if (!cfg?.roomId) throw new Error("Ghosty Ads no está instalada");
    const { gsAds } = await import("./ads-gs.server");
    const r = await gsAds("campaigns");
    if (!r.ok) throw new Error(r.error);
    const g = (r.items ?? []).find((i) => String(i.id) === String(data.metaCampaignId));
    if (!g) throw new Error("esa campaña no está en la cuenta conectada");
    const C = await import("./ads-campaigns.server");
    const c = await C.importCampaign(g, cfg.roomId, user.sub);
    return { ok: true as const, id: c.id };
  });

// ── Reporte automático ───────────────────────────────────────────────────────

export const adsScheduleFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireOwner();
  const { getSchedule } = await import("./ads-report.server");
  return getSchedule();
});

export const setAdsScheduleFn = createServerFn({ method: "POST" })
  .validator((d: { enabled: boolean; hours: number[] }) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const { saveSchedule, getSchedule } = await import("./ads-report.server");
    const nextAt = await saveSchedule({ enabled: !!data.enabled, hours: data.hours }, user.sub, (await getSchedule()).tz);
    return { ok: true as const, nextAt };
  });

/** «Correr ahora»: publica el reporte aunque no haya cambios. */
export const adsRunReportFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireOwner();
  const { currentNamespace } = await import("../tenant.server");
  const { runReport } = await import("./ads-report.server");
  return runReport(await currentNamespace(), { force: true });
});
