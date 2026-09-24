// Webhook GENÉRICO de alertas: traduce el cuerpo de cualquier herramienta de monitoreo a
// una forma única que el canal y el agente entienden.
//
// Por qué uno genérico y no un conector por proveedor (decidido 2026-09-24): no hacemos un
// Datadog propio. El cliente ya tiene su monitoreo; casi todos (Datadog, Grafana/
// Alertmanager, Better Stack, UptimeRobot…) saben mandar un webhook cuando se dispara un
// monitor, y eso no pide permiso a nadie (el OAuth de Datadog, en cambio, es sólo para
// partners aprobados). Lo que vendemos es que la fábrica REACCIONE, no guardar telemetría.
//
// ⚠️ El cuerpo NO es de confianza: sólo se pinta como texto y se usa para agrupar. Nunca
// decide a dónde va nada — eso viaja firmado en el token.

export type AlertStatus = "firing" | "resolved" | "unknown";

export type NormalizedAlert = {
  source: string;
  title: string;
  body: string;
  status: AlertStatus;
  link: string;
  /** Id del proveedor para no repetir la MISMA entrega (reintentos). Vacío si no trae. */
  eventId: string;
  /** Huella del PROBLEMA: agrupa repeticiones y recuperaciones de la misma alerta. */
  key: string;
};

type Obj = Record<string, any>;

const str = (v: unknown, max = 500): string =>
  typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "";

const first = (...vs: unknown[]): string => {
  for (const v of vs) {
    const s = str(v, 4000);
    if (s) return s;
  }
  return "";
};

function statusFrom(raw: string): AlertStatus {
  const s = raw.toLowerCase();
  if (!s) return "unknown";
  if (/(resolv|recover|\bok\b|^up$|\bup\b|clos|normal)/.test(s)) return "resolved";
  if (/(fir|trigger|alert|down|warn|crit|error|fail|open|start|no ?data)/.test(s)) return "firing";
  return "unknown";
}

function safeLink(v: string): string {
  return /^https?:\/\//i.test(v) ? v.slice(0, 500) : "";
}

/** Una línea estable para la huella: sin números sueltos (cambian entre ocurrencias). */
function stable(s: string): string {
  return s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function normalizeAlert(p: Obj): NormalizedAlert {
  // ── Grafana / Alertmanager ─────────────────────────────────────────────────
  if (Array.isArray(p.alerts) && (p.groupKey != null || p.receiver != null || p.status != null)) {
    const a = (p.alerts[0] ?? {}) as Obj;
    const labels = (a.labels ?? p.commonLabels ?? {}) as Obj;
    const ann = (a.annotations ?? p.commonAnnotations ?? {}) as Obj;
    const name = first(labels.alertname, p.title);
    return finish({
      source: p.orgId != null || p.title ? "Grafana" : "Alertmanager",
      title: first(p.title, ann.summary, name, "Alerta"),
      body: first(p.message, ann.description, ann.summary),
      status: statusFrom(first(p.status, a.status)),
      link: safeLink(first(a.generatorURL, p.externalURL)),
      eventId: "",
      keyBase: `${name}|${first(labels.instance, labels.job, labels.service)}`,
    });
  }

  // ── Better Stack (Uptime) ──────────────────────────────────────────────────
  if (p.data?.attributes && typeof p.data.attributes === "object") {
    const at = p.data.attributes as Obj;
    const resolved = !!at.resolved_at || /resolv/i.test(str(at.status));
    return finish({
      source: "Better Stack",
      title: first(at.name, at.url, "Incidente"),
      body: first(at.cause, at.url),
      status: resolved ? "resolved" : "firing",
      link: safeLink(first(at.url)),
      eventId: `${first(p.data.id)}:${resolved ? "r" : "f"}`,
      keyBase: first(at.url, at.name, p.data.id),
    });
  }

  // ── UptimeRobot ────────────────────────────────────────────────────────────
  if (p.monitorFriendlyName != null || p.alertTypeFriendlyName != null || p.monitorURL != null) {
    const type = first(p.alertTypeFriendlyName, p.alertType === "2" || p.alertType === 2 ? "Up" : p.alertType ? "Down" : "");
    return finish({
      source: "UptimeRobot",
      title: `${first(p.monitorFriendlyName, p.monitorURL, "Monitor")}${type ? ` · ${type}` : ""}`,
      body: first(p.alertDetails, p.monitorURL),
      status: statusFrom(type),
      link: safeLink(first(p.monitorURL)),
      eventId: first(p.alertID),
      keyBase: first(p.monitorID, p.monitorURL, p.monitorFriendlyName),
    });
  }

  // ── Datadog (plantilla por defecto o la que sugerimos) ─────────────────────
  if (p.alert_transition != null || p.alert_id != null || p.event_type != null || p.org?.name != null) {
    return finish({
      source: "Datadog",
      title: first(p.title, p.alert_title, "Monitor de Datadog"),
      body: first(p.body, p.text, p.event_msg),
      status: statusFrom(first(p.alert_transition, p.alert_status, p.title)),
      link: safeLink(first(p.link, p.url)),
      eventId: first(p.id, p.event_id),
      keyBase: first(p.alert_id, p.monitor_id, stable(first(p.title, p.alert_title))),
    });
  }

  // ── Cualquier otra cosa ────────────────────────────────────────────────────
  const title = first(p.title, p.name, p.summary, p.subject, p.alert, p.event, "Alerta");
  return finish({
    source: first(p.source, p.service, p.app, "Webhook"),
    title,
    body: first(p.message, p.text, p.body, p.description, p.details),
    status: statusFrom(first(p.status, p.state, p.level, p.severity, p.type)),
    link: safeLink(first(p.url, p.link, p.href)),
    eventId: first(p.id, p.event_id, p.eventId),
    keyBase: stable(title),
  });
}

function finish(a: Omit<NormalizedAlert, "key"> & { keyBase: string }): NormalizedAlert {
  const { keyBase, ...rest } = a;
  return {
    ...rest,
    title: rest.title.slice(0, 200),
    body: rest.body.slice(0, 1500),
    key: `${rest.source}|${stable(keyBase || rest.title)}`,
  };
}

/** Tarjeta del canal. Texto plano en markdown: el cuerpo es del proveedor, no nuestro. */
export function formatGenericAlert(a: NormalizedAlert, hookName: string): string {
  const icon = a.status === "resolved" ? "✅" : "🚨";
  const estado = a.status === "resolved" ? "recuperado" : a.status === "firing" ? "disparada" : "aviso";
  const lines = [`${icon} **${a.title}** · ${a.source} · ${estado}`];
  if (a.body) lines.push(a.body.split("\n").slice(0, 8).join("\n"));
  if (a.link) lines.push(`[Abrir en ${a.source}](${a.link})`);
  lines.push(`_webhook «${hookName}»_`);
  return lines.join("\n\n");
}

/** Cuerpo crudo → objeto, venga como JSON, form-urlencoded o texto suelto. */
export function parseAlertBody(raw: string): Obj | null {
  if (!raw) return null;
  if (raw.length > 200_000) return null;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? (j as Obj) : { message: String(j) };
  } catch {
    /* no es JSON */
  }
  if (/^[\w.%-]+=/.test(raw) && raw.includes("=")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { message: raw.slice(0, 4000) };
}
