// Salida de un formulario a otro sistema.
//
// Cada vertical tiene su CRM, y esto es lo que vuelve integrable un producto multi-vertical
// sin escribir una línea de código por cliente. Estructuralmente es una copia de
// `reminders.server.ts`: cola en DB + poll, `arm…(ns)` desde `ensureSchema`, `setInterval`
// con `unref` y `withNamespace` por barrido. El timer es DESECHABLE — la verdad son las
// filas, así que un reinicio sólo puede entregar tarde, nunca perder.
//
// ⚠️ El riesgo de esto no es técnico: es mandar un intake médico a la URL equivocada, en
// automático y para siempre. De ahí las cuatro compuertas, que no son negociables:
//
//   1. El hook nace APAGADO y sólo lo prende el DUEÑO autenticado. El agente propone.
//   2. Prenderlo exige un ping firmado que conteste 2xx: una URL con errata no se activa.
//   3. `include_files` es un opt-in aparte — mandar el enlace de un acta de nacimiento a un
//      tercero es una decisión distinta de mandarle los campos del formulario.
//   4. `gt_form_deliveries` deja constancia de cada intento.
//
// El submit NO llama a nadie: sólo encola, dentro del try/catch que ya existe. Un CRM lento
// no puede hacer esperar a quien acaba de llenar un formulario.
import { dbq, num } from "../../dbq.server";
import { withNamespace } from "./../tenant.server";

const TICK_MS = 20_000;
/** 8 y no 20: veinte con backoff son días de ruido para algo que ya está roto. */
const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;

export type FormHook = {
  id: string;
  formId: string;
  url: string;
  enabled: boolean;
  includeFiles: boolean;
  disabledReason: string | null;
  /** Sólo se entrega al dueño, y por eso no viaja en las listas del agente. */
  secret?: string;
};

function toHook(r: Record<string, string | null>): FormHook {
  return {
    id: r.id!,
    formId: r.form_id!,
    url: r.url!,
    enabled: r.enabled === "1" || r.enabled === "true",
    includeFiles: r.include_files === "1" || r.include_files === "true",
    disabledReason: r.disabled_reason ?? null,
  };
}

// ── SSRF ────────────────────────────────────────────────────────────────────────
// La URL la escribe un usuario y la petición sale de NUESTRA red, con acceso al bridge del
// host y a lo que haya en la red privada. Un `http://169.254.169.254/...` es el clásico.

const PRIVADAS = [
  /^127\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^0\./, /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
];

/** `null` = está bien; un string = el motivo del rechazo. */
export async function urlProhibida(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "la URL no es válida";
  }
  // `https` obligatorio: el payload lleva datos de un intake. En texto plano, no.
  if (u.protocol !== "https:") return "tiene que ser https";
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return "no se puede apuntar a la red interna";
  }
  // Se resuelve el nombre: `algo.midominio.com` puede apuntar a 10.0.0.5, y comprobar sólo
  // el texto del host no vería nada.
  try {
    const dns = await import("node:dns/promises");
    const dirs = await dns.lookup(host, { all: true });
    for (const d of dirs) {
      const ip = d.address;
      if (d.family === 6) {
        const v6 = ip.toLowerCase();
        // Loopback, link-local y las direcciones únicas locales (fc00::/7).
        if (v6 === "::1" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) {
          return "no se puede apuntar a la red interna";
        }
        // ::ffff:10.0.0.1 y compañía.
        const m = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(v6);
        if (m && PRIVADAS.some((re) => re.test(m[1]))) return "no se puede apuntar a la red interna";
        continue;
      }
      if (PRIVADAS.some((re) => re.test(ip))) return "no se puede apuntar a la red interna";
    }
  } catch {
    return "no se pudo resolver ese dominio";
  }
  return null;
}

// ── Firma ───────────────────────────────────────────────────────────────────────

/**
 * Calcada de `partner-hmac`: canonical `${ts}.${rawBody}`, HMAC-SHA256, ventana de ±300 s
 * del lado de quien recibe. Se documenta así para que un tercero pueda replicarla sin
 * leernos el código, y hay un vector fijo en los tests.
 */
export async function signBody(secret: string, ts: number, rawBody: string): Promise<string> {
  const crypto = await import("node:crypto");
  return crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
}

// ── Alta y administración (dueño autenticado) ───────────────────────────────────

export async function listHooks(formId: string): Promise<FormHook[]> {
  const rows = await dbq(
    `SELECT id, form_id, url, enabled, include_files, disabled_reason FROM gt_form_hooks WHERE form_id = ?`,
    [formId]
  );
  return rows.map(toHook);
}

/** Da de alta un hook APAGADO. Es lo único que puede hacer el agente. */
export async function proposeHook(a: {
  formId: string;
  url: string;
  includeFiles?: boolean;
}): Promise<{ ok: true; hook: FormHook } | { ok: false; error: string }> {
  const { getForm } = await import("./publish.server");
  const form = await getForm(a.formId);
  if (!form) return { ok: false, error: "ese formulario no existe" };
  const mal = await urlProhibida(a.url);
  if (mal) return { ok: false, error: mal };

  const { randomUUID, randomBytes } = await import("node:crypto");
  const id = `hook_${randomUUID()}`;
  await dbq(
    `INSERT INTO gt_form_hooks (id, form_id, url, secret, enabled, include_files, disabled_reason)
     VALUES (?,?,?,?,0,?,?)`,
    [id, form.id, a.url, randomBytes(32).toString("hex"), a.includeFiles ? 1 : 0, "recién creado, falta activarlo"]
  );
  const hooks = await listHooks(form.id);
  return { ok: true, hook: hooks.find((h) => h.id === id)! };
}

/**
 * Prende un hook, y sólo si contesta.
 *
 * El ping es una entrega de verdad —mismo formato, misma firma— con `event:"ping"`. Una URL
 * con una errata, un dominio que ya no es de nadie o un endpoint que aún no existe se quedan
 * apagados en vez de acumular entregas muertas durante días.
 */
export async function enableHook(
  hookId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await dbq(`SELECT id, form_id, url, secret FROM gt_form_hooks WHERE id = ?`, [hookId]);
  const h = rows[0];
  if (!h) return { ok: false, error: "ese destino no existe" };
  const mal = await urlProhibida(h.url!);
  if (mal) return { ok: false, error: mal };

  const r = await entregar(h.url!, h.secret!, `ping_${h.id}`, { event: "ping", formId: h.form_id, data: {} });
  if (!r.ok) {
    await dbq(`UPDATE gt_form_hooks SET disabled_reason = ?, updated_at = unixepoch() WHERE id = ?`, [
      `no contestó al activarlo: ${r.error}`.slice(0, 200),
      hookId,
    ]);
    return { ok: false, error: `no contestó: ${r.error}` };
  }
  await dbq(
    `UPDATE gt_form_hooks SET enabled = 1, disabled_reason = NULL, updated_at = unixepoch() WHERE id = ?`,
    [hookId]
  );
  return { ok: true };
}

export async function disableHook(hookId: string, reason: string | null = null): Promise<void> {
  await dbq(`UPDATE gt_form_hooks SET enabled = 0, disabled_reason = ?, updated_at = unixepoch() WHERE id = ?`, [
    reason,
    hookId,
  ]);
}

export async function deleteHook(hookId: string): Promise<void> {
  await dbq(`DELETE FROM gt_form_deliveries WHERE hook_id = ?`, [hookId]);
  await dbq(`DELETE FROM gt_form_hooks WHERE id = ?`, [hookId]);
}

// ── Encolar ─────────────────────────────────────────────────────────────────────

/** Lo llama `deliverSubmission`. No manda nada: sólo deja la fila. */
export async function enqueueDeliveries(formId: string, submissionId: number): Promise<number> {
  const rows = await dbq(`SELECT id FROM gt_form_hooks WHERE form_id = ? AND enabled = 1`, [formId]);
  for (const h of rows) {
    // El UNIQUE (hook_id, submission_id) hace que un re-encolado no pueda duplicar nada.
    await dbq(
      `INSERT INTO gt_form_deliveries (hook_id, submission_id, form_id) VALUES (?,?,?)
       ON CONFLICT(hook_id, submission_id) DO NOTHING`,
      [h.id, submissionId, formId]
    );
  }
  return rows.length;
}

// ── El runner ───────────────────────────────────────────────────────────────────

const tenants = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function armFormWebhooks(ns: string): void {
  tenants.add(ns);
  if (timer) return;
  timer = setInterval(() => { void sweep(); }, TICK_MS);
  timer.unref?.();
  void sweep();
}

async function sweep(): Promise<void> {
  for (const ns of Array.from(tenants)) {
    try {
      await withNamespace(ns, () => sweepTenant(ns));
    } catch {
      // Un tenant con la DB flapeando no puede dejar sin entregas a los demás; sus filas
      // siguen pendientes y el próximo tick reintenta.
    }
  }
}

async function sweepTenant(ns: string): Promise<void> {
  const pend = await dbq(
    `SELECT id FROM gt_form_deliveries WHERE state = 'pending' AND next_at <= unixepoch() ORDER BY next_at LIMIT 20`
  );
  for (const p of pend) {
    // CLAIM atómico: dos procesos (o dos ticks traslapados porque una entrega tardó) no
    // pueden mandar el mismo POST dos veces.
    const claimed = await dbq(
      `UPDATE gt_form_deliveries SET state = 'sending', updated_at = unixepoch()
        WHERE id = ? AND state = 'pending' RETURNING id`,
      [p.id]
    );
    if (!claimed.length) continue;
    await intentar(ns, num(p.id)).catch((e) => console.error("[form hook] intento falló", e));
  }
}

async function intentar(ns: string, deliveryId: number): Promise<void> {
  const rows = await dbq(
    `SELECT d.id, d.hook_id, d.submission_id, d.form_id, d.attempts,
            h.url, h.secret, h.include_files, h.enabled
       FROM gt_form_deliveries d JOIN gt_form_hooks h ON h.id = d.hook_id
      WHERE d.id = ?`,
    [deliveryId]
  );
  const d = rows[0];
  // El hook se borró o se apagó mientras la entrega esperaba: no se manda. Apagar un
  // destino tiene que surtir efecto sobre lo que ya está en la cola, o "desconectarlo" no
  // significa nada.
  if (!d || d.enabled !== "1") {
    await dbq(`UPDATE gt_form_deliveries SET state='dead', last_error='destino desactivado' WHERE id=?`, [
      deliveryId,
    ]);
    return;
  }

  const intentos = num(d.attempts) + 1;
  const payload = await armarPayload(d.form_id!, num(d.submission_id), d.include_files === "1");
  if (!payload) {
    await dbq(`UPDATE gt_form_deliveries SET state='dead', last_error='la respuesta ya no existe' WHERE id=?`, [
      deliveryId,
    ]);
    return;
  }

  const r = await entregar(d.url!, d.secret!, `dlv_${deliveryId}`, payload);
  if (r.ok) {
    await dbq(
      `UPDATE gt_form_deliveries SET state='ok', attempts=?, last_status=?, last_error=NULL, updated_at=unixepoch() WHERE id=?`,
      [intentos, r.status ?? 200, deliveryId]
    );
    return;
  }

  if (intentos >= MAX_ATTEMPTS) {
    await dbq(
      `UPDATE gt_form_deliveries SET state='dead', attempts=?, last_status=?, last_error=?, updated_at=unixepoch() WHERE id=?`,
      [intentos, r.status ?? null, r.error.slice(0, 300), deliveryId]
    );
    await disableHook(d.hook_id!, `se agotaron los reintentos: ${r.error}`.slice(0, 200));
    await avisarAlDueno(ns, d.form_id!, r.error);
    return;
  }

  // Backoff exponencial con jitter, para no sincronizar todos los reintentos de un CRM que
  // se acaba de caer.
  const espera = Math.min(3600, Math.pow(2, intentos) * 15) + Math.floor(Math.random() * 20);
  await dbq(
    `UPDATE gt_form_deliveries SET state='pending', attempts=?, next_at=unixepoch()+?, last_status=?, last_error=?, updated_at=unixepoch() WHERE id=?`,
    [intentos, espera, r.status ?? null, r.error.slice(0, 300), deliveryId]
  );
}

/**
 * `data` con las claves internas y `labels` aparte.
 *
 * Es la misma razón por la que `listSubmissions` traduce: el tercero mapea contra etiquetas
 * estables sin que le entreguemos nuestro esquema interno como contrato. Si un día se
 * renombra un campo, su integración no se cae.
 */
async function armarPayload(
  formId: string,
  submissionId: number,
  includeFiles: boolean
): Promise<Record<string, unknown> | null> {
  const { getForm } = await import("./publish.server");
  const { safeJson } = await import("./submissions.server");
  const form = await getForm(formId);
  if (!form) return null;
  const rows = await dbq(
    `SELECT id, created_at, data_json, files_json FROM gt_form_submissions WHERE id = ? AND form_id = ?`,
    [submissionId, formId]
  );
  if (!rows[0]) return null;

  const data = safeJson<Record<string, string>>(rows[0].data_json, {});
  const out: Record<string, unknown> = {
    event: "form.submission",
    formId: form.id,
    formTitle: form.title,
    submissionId,
    at: new Date(num(rows[0].created_at) * 1000).toISOString(),
    data,
    labels: Object.fromEntries(form.fields.map((f) => [f.name, f.label])),
  };
  // Los archivos son un opt-in aparte: mandarle a un tercero el nombre y el id de un acta de
  // nacimiento es una decisión distinta de mandarle los campos.
  if (includeFiles) out.files = safeJson<Record<string, unknown>>(rows[0].files_json, {});
  return out;
}

async function entregar(
  url: string,
  secret: string,
  deliveryId: string,
  payload: Record<string, unknown>
): Promise<{ ok: true; status: number } | { ok: false; status?: number; error: string }> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signBody(secret, ts, body);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      // `manual`: un 302 a `http://169.254.169.254` se saltaría toda la comprobación de
      // arriba, que se hizo sobre la URL original.
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "X-Ghosty-Event": String(payload.event ?? "form.submission"),
        "X-Ghosty-Delivery": deliveryId,
        "X-Ghosty-Timestamp": String(ts),
        "X-Ghosty-Signature": `sha256=${sig}`,
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

/** Una integración muerta que nadie mira es peor que no tenerla: el dueño se entera. */
async function avisarAlDueno(ns: string, formId: string, motivo: string): Promise<void> {
  try {
    const { getForm } = await import("./publish.server");
    const form = await getForm(formId);
    if (!form?.ownerSub) return;
    const chan = await dbq("SELECT slug FROM gc_channels WHERE id = ?", [form.channelId]);
    const { notify } = await import("../notify.server");
    await notify(
      {
        kind: "form",
        recipients: [form.ownerSub],
        title: `⚠️ Se desconectó la salida de ${form.title}`,
        body: `No respondió tras ${MAX_ATTEMPTS} intentos (${motivo.slice(0, 80)}). Las respuestas siguen guardándose aquí.`,
        url: chan[0]?.slug ? `/c/${chan[0].slug}` : "/forms",
      },
      ns
    );
  } catch (e) {
    console.error("[form hook] aviso al dueño falló", e);
  }
}
