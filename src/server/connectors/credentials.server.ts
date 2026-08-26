// Hermana de `oauth.server.ts` para los conectores que se conectan con credenciales
// tecleadas (Odoo, Kommo, los que vengan).
//
// ⚠️ Deliberadamente NO se toca `getValidToken` (oauth.server.ts:149). Ese camino hace
// `if (!def?.oauth) return null`, y ese `null` es INDISTINGUIBLE de "no conectado": el molde
// que todos los conectores copian lo traduce a "conéctala en Ajustes", así que el panel
// diría Conectado y el agente insistiría en que no lo está. Bucle sin salida y sin un solo
// log. Aquí se resuelve por separado, con riesgo cero para los cuatro conectores OAuth.

import { getConnectorRow, setConnectorRow, setConnectorMeta } from "./store.server";
import { getConnector } from "./registry";
import { assertPublicOrigin } from "./net-guard.server";
import { loaderFor } from "./impl";

export type Credentials<F = Record<string, string>> = {
  /** La API key / token. Vive en `access_token`, igual que un token OAuth. */
  secret: string;
  /** Los campos no secretos (url, db, login…), tal como se guardaron. */
  fields: F;
  /** Base URL ya normalizada y validada. */
  origin: string;
  externalId: string | null;
  probe: Record<string, unknown>;
};

/** Marca del `meta` de una fila de credenciales, para no confundirla con una de OAuth. */
const KIND = "credentials";

/**
 * Mensaje único para toda la familia. Lo lee el MODELO: por eso dice qué hacer, y por eso
 * no dice "null" ni "403" — un error opaco lleva al modelo a inventar excusas.
 */
export function notConnected(name: string): { error: string } {
  return {
    error:
      `La cuenta de ${name} no está conectada, o sus credenciales dejaron de ser válidas. ` +
      `Pídele a la persona que la conecte en Ajustes → Integraciones.`,
  };
}

/**
 * Credenciales vivas de (sub, provider), o `null` si no hay conexión utilizable.
 *
 * El origin se revalida en CADA lectura contra el guard de red: se guardó hace meses y el
 * DNS pudo cambiar de dueño desde entonces. Es barato — la resolución va cacheada 60s.
 */
export async function getCredentials<F = Record<string, string>>(
  sub: string,
  provider: string
): Promise<Credentials<F> | null> {
  const def = getConnector(provider);
  if (!def?.credentials) return null;
  const row = await getConnectorRow(sub, provider);
  if (!row?.access_token || !row.meta) return null;

  let meta: any;
  try {
    meta = JSON.parse(row.meta);
  } catch {
    return null;
  }
  if (meta?.kind !== KIND || typeof meta.origin !== "string") return null;

  try {
    // No se confía en el `origin` guardado: se vuelve a pasar por el guard.
    const origin = await assertPublicOrigin(meta.origin, def.credentials);
    return {
      secret: row.access_token,
      fields: (meta.fields ?? {}) as F,
      origin,
      externalId: row.external_id,
      probe: (meta.probe ?? {}) as Record<string, unknown>,
    };
  } catch (e) {
    console.warn(`[connectors] ${provider}: el origin guardado ya no pasa el guard de red:`, String(e));
    return null;
  }
}

/** Los campos que el formulario debe pintar, sin un solo valor. */
export function describeCredentials(providerId: string) {
  const def = getConnector(providerId);
  if (!def?.credentials) return null;
  const { fields, intro, docsUrl } = def.credentials;
  return {
    intro: intro ?? null,
    docsUrl: docsUrl ?? null,
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      placeholder: f.placeholder ?? null,
      help: f.help ?? null,
      required: f.required !== false,
    })),
  };
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Valida, PRUEBA y persiste las credenciales. El orden importa:
 *
 * 1. campos requeridos,
 * 2. guard de red sobre los `host:true` — antes de que nadie haga una petición,
 * 3. `verifyCredentials` del módulo,
 * 4. y sólo entonces se escribe la fila.
 *
 * ⚠️ **Nunca se persiste sin ping verde.** Una fila con credenciales malas se lee en todo el
 * sistema como "conectado" (el criterio es `access_token IS NOT NULL`), así que el fallo no
 * aparecería aquí sino más tarde, delante de un cliente.
 */
export async function saveCredentials(
  sub: string,
  provider: string,
  raw: Record<string, string>
): Promise<SaveResult> {
  const def = getConnector(provider);
  if (!def?.credentials) return { ok: false, error: "ese proveedor no se conecta con credenciales" };

  const fields: Record<string, string> = {};
  for (const f of def.credentials.fields) {
    const value = String(raw?.[f.key] ?? "").trim();
    if (!value) {
      if (f.required !== false) return { ok: false, error: `Falta ${f.label}.` };
      continue;
    }
    fields[f.key] = value;
  }

  // Guard de red antes de cualquier petición, sobre todos los campos que sean host.
  let origin = "";
  for (const f of def.credentials.fields) {
    if (!f.host || !fields[f.key]) continue;
    try {
      origin = await assertPublicOrigin(fields[f.key], def.credentials, f.hostTemplate);
      fields[f.key] = origin;
    } catch (e) {
      return { ok: false, error: `${f.label}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (!origin) return { ok: false, error: "ese conector no declara una dirección; es un error de configuración" };

  const load = loaderFor(provider);
  if (!load) return { ok: false, error: "ese proveedor no está disponible" };
  const mod = await load();
  if (!mod.verifyCredentials) return { ok: false, error: "ese proveedor no sabe comprobar credenciales" };

  let verdict: Awaited<ReturnType<NonNullable<typeof mod.verifyCredentials>>>;
  try {
    verdict = await mod.verifyCredentials(fields);
  } catch (e) {
    return { ok: false, error: `No se pudo comprobar la conexión: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!verdict.ok) return { ok: false, error: verdict.error };

  const secretField = def.credentials.fields.find((f) => f.secret);
  const secret = secretField ? fields[secretField.key] : "";
  if (!secret) return { ok: false, error: "falta la credencial" };

  // Lo no secreto va al `meta`; el secreto a `access_token`. Sin columnas nuevas.
  const publicFields: Record<string, string> = {};
  for (const f of def.credentials.fields) {
    if (!f.secret && fields[f.key]) publicFields[f.key] = fields[f.key];
  }
  const meta = {
    kind: KIND,
    origin,
    fields: publicFields,
    verified_at: Math.floor(Date.now() / 1000),
    probe: verdict.probe ?? {},
  };

  await setConnectorRow({
    sub,
    provider,
    accessToken: secret,
    // ⚠️ NULL, jamás 0: una API key no caduca, y un `WHERE expires_at < unixepoch()` en el
    // futuro (un cron de limpieza, un badge "caducada") mataría todas estas conexiones de
    // golpe. NULL es la única semántica de "no vence".
    refreshToken: null,
    expiresAt: null,
    externalId: verdict.externalId ?? null,
    meta,
  });
  // `setConnectorRow` usa COALESCE en meta/external_id (no pisa con null), así que para
  // REconectar con datos distintos hay que reescribirlos explícitamente.
  await setConnectorMeta(sub, provider, { meta, externalId: verdict.externalId ?? null });
  return { ok: true };
}
