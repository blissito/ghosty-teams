import { getVapidKeyFn, subscribePushFn, unsubscribePushFn } from "../server/push";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function currentPushState(): Promise<"unsupported" | "denied" | "on" | "off"> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

// Reconciliación tras una ROTACIÓN de VAPID. Una suscripción firmada con la llave
// vieja sigue existiendo en el browser —`currentPushState()` dice "on"— pero el
// server ya no puede enviarle nada: el panel miente y no llega nada. Aquí se
// compara la applicationServerKey de la sub contra la vigente y, si difieren, se
// re-suscribe sola. El permiso ya está concedido → no hay prompt.
// Best-effort y silencioso: es una reparación de fondo, no una acción del usuario.
export async function reconcilePushSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return; // sin sub no hay nada que reconciliar (activar es decisión del usuario)
    const { key } = await getVapidKeyFn();
    const current = sub.options?.applicationServerKey;
    if (!current) return; // el browser no lo expone → no podemos comparar, no tocamos nada
    const a = new Uint8Array(current);
    const b = urlBase64ToUint8Array(key);
    if (a.length === b.length && a.every((v, i) => v === b[i])) return; // al día
    await enablePush(); // desuscribe la vieja y suscribe con la llave vigente
  } catch {
    /* SW muriendo / server caído → se reintenta en la próxima carga */
  }
}

// Pide permiso, suscribe y guarda en el server. Devuelve el nuevo estado.
export async function enablePush(): Promise<"on" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const { key } = await getVapidKeyFn();
  // Rotación de VAPID: si ya existe una suscripción (posiblemente con la llave
  // ANTERIOR), `subscribe()` con la nueva applicationServerKey lanza
  // ("a subscription with a different applicationServerKey already exists").
  // Desuscribimos la vieja primero → suscribir con la llave vigente siempre
  // funciona (idempotente ante rotación). Best-effort: si no hay o falla, seguimos.
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    try {
      await unsubscribePushFn({ data: { endpoint: existing.endpoint } });
    } catch {
      // el borrado server-side es best-effort
    }
    await existing.unsubscribe().catch(() => {});
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
  });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await subscribePushFn({
    data: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return "on";
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await unsubscribePushFn({ data: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}
