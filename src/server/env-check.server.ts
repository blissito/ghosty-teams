// ── Lo que el proceso necesita para servir: se comprueba al arrancar ─────────────
//
// El modo de falla que esto mata: una variable que falta **no rompe nada al arrancar**.
// El unit queda `active`, el puerto escucha, `/` contesta 307 y el journal no dice ni una
// palabra. El fallo aparece la primera vez que ALGUIEN usa la función que la necesitaba —
// que pueden ser semanas después y en la cara de un cliente.
//
// Nos ha pasado tres veces documentadas:
//   · La caja de Ghosty Tasks nunca tuvo `GHOSTY_RUNTIME_URL`: su agente **no funcionó
//     nunca** y el síntoma era «este workspace no tiene runtime configurado».
//   · Su `SQLD_AUTH_TOKEN` se quedó estático cuando sqld pasó a exigir JWT: tres días de
//     pantalla negra con el unit sano.
//   · La caja de llamadas se recreó y perdió sus llaves de LiveKit en silencio.
//
// El origen común es la **allowlist explícita** de los scripts de deploy: una clave que no
// esté en esa lista no se copia, y nadie se entera.
//
// ⚠️ Sólo MATA en producción. En una laptop lo normal es no tener las llaves de correo ni
// las de llamadas, y negarse a arrancar ahí haría que la gente comentara la comprobación —
// que es cómo mueren estas cosas. En dev avisa y sigue.

/** Sin esto el proceso no puede servir NADA: sesión, base de datos, o identidad. */
const REQUIRED: Record<string, string> = {
  SESSION_SECRET: "firma las cookies de sesión — sin esto nadie entra",
  SQLD_URL: "la base de datos del tenant",
  SQLD_NAMESPACE: "el tenant por defecto",
  SQLD_JWT_PRIVATE_KEY: "sqld exige JWT por namespace desde el 2026-08-17",
  GHOSTY_PARTNER_SECRET: "firma HMAC contra Studio (agentes, render, saldo)",
  GHOSTY_IDENTITY_URL: "dónde vive Studio",
};

/**
 * Funciones enteras que se apagan si falta su llave. NO impiden arrancar —un espacio sin
 * correo sigue sirviendo el chat— pero **tienen que decirse en voz alta**, porque desde
 * dentro del producto se ven como un bug: «no llegó el correo», «no entro a la llamada».
 */
const FEATURES: Record<string, string[]> = {
  "llamadas y salas": ["LK_API_KEY", "LK_API_SECRET", "HUDDLE_CONTROL_URL", "HUDDLE_WSS_URL"],
  "correo saliente": ["SES_KEY", "SES_SECRET", "SES_REGION", "SES_FROM"],
  // ⚠️ `STORAGE_BUCKET` NO va aquí: tiene default en `storage.server.ts`, y la caja de
  // producción no lo trae. Listarlo habría anunciado «archivos APAGADO» en cada arranque
  // con el storage funcionando perfectamente — un aviso falso enseña a ignorar los avisos.
  "archivos y artefactos": ["TIGRIS_ACCESS_KEY_ID", "TIGRIS_SECRET_ACCESS_KEY"],
  "co-edición de documentos": ["COLLAB_SECRET", "COLLAB_SIDECAR_WS_URL"],
  "agentes ACP (goose)": ["ACP_TICKET_SECRET"],
  "avisos push": ["VAPID_PRIVATE_KEY"],
};

const falta = (k: string) => !(process.env[k] ?? "").trim();

export function assertEnv(): void {
  const faltantes = Object.keys(REQUIRED).filter(falta);
  const apagadas = Object.entries(FEATURES)
    .map(([nombre, keys]) => [nombre, keys.filter(falta)] as const)
    .filter(([, keys]) => keys.length > 0);

  for (const [nombre, keys] of apagadas) {
    console.warn(`[env] APAGADO: ${nombre} — falta ${keys.join(", ")}`);
  }

  if (!faltantes.length) return;

  const detalle = faltantes.map((k) => `  · ${k} — ${REQUIRED[k]}`).join("\n");
  const msg = `[env] faltan ${faltantes.length} variable(s) sin las que no se puede servir:\n${detalle}`;

  if (process.env.NODE_ENV !== "production") {
    console.warn(`${msg}\n[env] (en dev sólo se avisa; en producción el proceso no arranca)`);
    return;
  }
  // Salir es el punto: systemd reintenta, falla, y `systemctl status` enseña ESTA lista.
  // Quedarse arriba sirviendo 500 sería el mismo silencio de siempre con otro disfraz.
  console.error(msg);
  process.exit(1);
}
