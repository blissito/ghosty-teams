/**
 * La configuración de envío es de la CAMPAÑA (la lista), no del espacio.
 *
 * Antes remitente, WhatsApp del botón, cierre, firma y mensaje base vivían en `gc_config` del
 * workspace: una sola campaña a la vez. Montar la de agencias (bliss, su WhatsApp) habría
 * cambiado el remitente y el número de la de normi035 (Rosalba, otro WhatsApp) a media
 * campaña. lemlist, Smartlead e Instantly lo resuelven igual: el espacio da los valores por
 * defecto y cada campaña guarda los suyos.
 *
 * Cómo:
 *  · `gt_prosp_lists.settings_json` guarda las llaves que la lista sobrescribe.
 *  · `withList(listId, fn)` abre un alcance (AsyncLocalStorage): dentro, `getConfig*` lee
 *    primero la lista y luego el espacio, y `setConfig` escribe EN LA LISTA. Fuera, todo es
 *    del espacio como siempre. Así `sender.server.ts` no cambia de forma: sólo de import.
 *  · `freezeCampaign` copia a la lista los valores del espacio la primera vez que se manda:
 *    cambiar los del espacio después ya no le mueve nada a una campaña que salió.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as base from "../../config.server";
import { dbq } from "../../dbq.server";

/** Lo que es de cada campaña. Lo demás (`prospeccion_permisos`, etc.) sigue siendo del espacio. */
export const CAMPAIGN_KEYS = [
  "prospeccion_from_email",
  "prospeccion_from_name",
  "prospeccion_wa_phone",
  "prospeccion_cta_kind",
  "prospeccion_cta_label",
  "prospeccion_cta_url",
  "prospeccion_cta_wa_text",
  "prospeccion_message_base",
  "prospeccion_last_subject",
  "prospeccion_signature_business",
  "prospeccion_signature_tagline",
  "prospeccion_signature_title",
  "prospeccion_signature_website",
  "prospeccion_signature_logo",
  "prospeccion_accent",
] as const;
const IS_CAMPAIGN = new Set<string>(CAMPAIGN_KEYS);

const scope = new AsyncLocalStorage<{ listId: number }>();

export function withList<T>(listId: number | null | undefined, fn: () => Promise<T>): Promise<T> {
  const id = Number(listId);
  return Number.isFinite(id) && id > 0 ? scope.run({ listId: id }, fn) : fn();
}

export function currentListId(): number | null {
  return scope.getStore()?.listId ?? null;
}

export async function listSettings(listId: number): Promise<Record<string, string>> {
  const rows = await dbq("SELECT settings_json FROM gt_prosp_lists WHERE id = ?", [listId]).catch(() => []);
  try {
    const o = JSON.parse(String(rows[0]?.settings_json ?? "{}"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

async function writeListSettings(listId: number, patch: Record<string, string>): Promise<void> {
  const cur = await listSettings(listId);
  await dbq("UPDATE gt_prosp_lists SET settings_json = ? WHERE id = ?", [JSON.stringify({ ...cur, ...patch }), listId]);
}

/** Mezcla pura: lo de la lista gana, sólo en llaves de campaña. Exportada para la prueba. */
export function mergeCampaign(
  keys: string[],
  workspace: Record<string, string | null>,
  list: Record<string, string>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = IS_CAMPAIGN.has(k) && k in list ? list[k] : (workspace[k] ?? null);
  return out;
}

export async function getConfigMany(keys: string[]): Promise<Record<string, string | null>> {
  const ws = await base.getConfigMany(keys);
  const id = currentListId();
  return id ? mergeCampaign(keys, ws, await listSettings(id)) : ws;
}

export async function getConfig(k: string): Promise<string | null> {
  return (await getConfigMany([k]))[k];
}

export async function setConfig(k: string, v: string): Promise<void> {
  const id = currentListId();
  if (id && IS_CAMPAIGN.has(k)) return writeListSettings(id, { [k]: v });
  return base.setConfig(k, v);
}

/**
 * Congela en la lista lo que hoy hereda del espacio. Se llama al mandar: desde ahí la
 * campaña es dueña de su remitente, su número y su cierre. Lo que la lista ya tenía no se toca.
 */
export async function freezeCampaign(listId: number): Promise<void> {
  const cur = await listSettings(listId);
  const missing = CAMPAIGN_KEYS.filter((k) => !(k in cur));
  if (!missing.length) return;
  const ws = await base.getConfigMany([...missing]);
  const patch: Record<string, string> = {};
  for (const k of missing) patch[k] = ws[k] ?? "";
  await writeListSettings(listId, patch);
}

/** ¿La lista ya tiene configuración propia? (para decirle a la persona de dónde sale cada cosa) */
export async function hasOwnSettings(listId: number): Promise<boolean> {
  return Object.keys(await listSettings(listId)).some((k) => IS_CAMPAIGN.has(k));
}
