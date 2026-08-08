// Identidad de BOT para la GitHub App: installation tokens (server-to-server).
//
// ⚠️ Por qué existe, y no es cosmético. Hoy todo sale con token *user-to-server*, o sea
// que un PR que abre el agente lo AUTORA la persona que lo pidió — y **GitHub prohíbe de
// forma dura que el autor apruebe su propio pull request**, sin ajuste que lo revierta.
// Así que el botón "Aprobar" de la tarjeta nace muerto para quien encargó el cambio. Con
// el bot como autor, cualquiera del equipo puede aprobarlo. Es la razón por la que Devin
// (`devin-ai-integration[bot]`), Cursor (`cursoragent`), Jules (`google-labs-jules[bot]`)
// y Charlie (`CharlieCreates`) hacen exactamente esto.
//
// ⚠️ Lo que se PIERDE, y por eso `assertCanPush` existe: un token user-to-server sólo
// tiene "permissions that both the user and the app have" — una intersección. El
// installation token no: su techo es el de la App, igual para todos. Sin re-imponer nada,
// alguien sin permiso de empuje podría hacer que el bot empuje por él. Lo mismo vale para
// la trazabilidad: en el audit log de GitHub el actor pasa a ser el bot, así que quién
// pidió qué sólo vive en NUESTRO lado.
//
// Nace APAGADO: sin `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` todo esto devuelve null y
// el conector sigue exactamente como hoy. Encenderlo es inyectar esos dos secretos.
import { createSign } from "node:crypto";

const API = "https://api.github.com";

/**
 * La llave privada como PEM utilizable, o null.
 *
 * ⚠️ **Preferir SIEMPRE `GITHUB_APP_PRIVATE_KEY_B64`.** Un PEM en una sola línea con `\n`
 * escapados atraviesa demasiadas capas que tratan la barra invertida como suya, y basta
 * que UNA la interprete para romperlo. Pasó en producción el 2026-08-06: **systemd se comió
 * las barras** al parsear el `EnvironmentFile`, así que el archivo tenía la llave correcta
 * —28 líneas, firmaba bien— y `process.env` recibía `-----BEGIN RSA PRIVATE KEY-----nMIIE…`.
 *
 * Y no se puede reparar en código: una `n` suelta es indistinguible de una `n` legítima del
 * base64. Por eso la salida no es un `replace` más listo, es no meter barras nunca.
 *
 * El camino con `\n` se conserva sólo para no romper un despliegue que ya lo tenga puesto.
 */
function privateKeyPem(): string | null {
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;
  if (b64) {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    if (pem.includes("-----BEGIN")) return pem;
  }
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) return null;
  const pem = raw.replace(/\\n/g, "\n");
  // Sin cabecera en su propia línea, `createSign` sólo sabe decir "DECODER
  // routines::unsupported", que no menciona ni la llave ni el escapado y manda a
  // diagnosticar el OAuth del usuario. Aquí se descarta antes y se dice qué pasa.
  return pem.includes("-----BEGIN") && pem.includes("\n") ? pem : null;
}

/** ¿Está configurada la identidad de bot? Si no, el conector opera como el usuario. */
export function botIdentityEnabled(): boolean {
  return !!(process.env.GITHUB_APP_ID && privateKeyPem());
}

/**
 * JWT RS256 firmado con la llave privada de la App. Vale 10 min como máximo (GitHub lo
 * rechaza si pides más) y sólo sirve para pedir installation tokens.
 */
export function appJwtOrNull(): string | null {
  return botIdentityEnabled() ? appJwt() : null;
}

function appJwt(): string {
  const pem = privateKeyPem()!;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // `iat` 60s en el pasado: GitHub rechaza el token si el reloj de la máquina va
  // adelantado, y es un fallo intermitente carísimo de diagnosticar.
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(pem, "base64url")}`;
}

// Los installation tokens duran 1 h. Se cachean con margen de 5 min.
// ⚠️ La clave del caché DEBE llevar el scope completo (repo + permisos): un token
// recortado a un repo servido desde la entrada genérica —o al revés— le daría a un
// repo el alcance de otro.
const cache = new Map<string, { token: string; exp: number }>();

type InstallationTokenOpts = {
  /** Recorta el token a UN repo (nombre sin dueño). Sin esto alcanza toda la instalación. */
  onlyRepo?: string;
  /** Baja `contents` a sólo lectura. Para tokens que salen hacia la caja del agente. */
  readOnly?: boolean;
};

/** Token del bot para una instalación concreta. `null` si la identidad no está encendida. */
export async function installationToken(
  installationId: number,
  opts?: InstallationTokenOpts,
): Promise<string | null> {
  if (!botIdentityEnabled() || !Number.isFinite(installationId)) return null;
  const key = `${installationId}:${opts?.onlyRepo ?? "*"}:${opts?.readOnly ? "ro" : "rw"}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.exp - now > 300_000) return hit.token;
  const body =
    opts?.onlyRepo || opts?.readOnly
      ? JSON.stringify({
          ...(opts.onlyRepo ? { repositories: [opts.onlyRepo] } : {}),
          ...(opts.readOnly ? { permissions: { contents: "read" } } : {}),
        })
      : undefined;
  try {
    const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
    if (!res.ok) {
      console.warn(`[github-app] no pude minar installation token: ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { token?: string; expires_at?: string };
    if (!j.token) return null;
    cache.set(key, { token: j.token, exp: Date.parse(j.expires_at ?? "") || now + 3_600_000 });
    return j.token;
  } catch (e) {
    console.warn("[github-app] fallo minando installation token:", e);
    return null;
  }
}

/**
 * Re-impone el permiso que el installation token se salta.
 *
 * Devuelve el motivo del rechazo, o `null` si puede empujar. Se consulta CON EL TOKEN DEL
 * USUARIO a propósito: si el propio solicitante no puede ni leer el repo, la llamada
 * falla y eso ya es la respuesta.
 */
export async function pushDenialReason(
  userToken: string,
  repoPath: string,
  login: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${API}/repos/${repoPath}/collaborators/${login}/permission`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return "No pude comprobar tus permisos sobre ese repositorio.";
    const j = (await res.json()) as { permission?: string };
    // `admin` y `write` empujan; `read` y `none`, no. `maintain`/`triage` llegan aquí
    // como "write"/"read" en este endpoint, así que no hay que enumerarlos.
    if (j.permission === "admin" || j.permission === "write") return null;
    return `No tienes permiso de escritura en ese repositorio (tu acceso es "${j.permission ?? "ninguno"}").`;
  } catch {
    return "No pude comprobar tus permisos sobre ese repositorio.";
  }
}

/**
 * El trailer que conserva a la persona en el blame y en su gráfico de contribuciones.
 * Es la convención que usan Cursor, Jules y Devin, y GitHub la reconoce siempre que el
 * correo esté asociado a la cuenta — de ahí el `no-reply`, que siempre lo está.
 */
export function coAuthorTrailer(login: string, email?: string | null): string {
  const mail = email && email.includes("@") ? email : `${login}@users.noreply.github.com`;
  return `\n\nCo-authored-by: ${login} <${mail}>`;
}

/**
 * Constancia de que un agente REDACTÓ esto, para lo que sale a nombre de la persona.
 *
 * Los PRs y las ramas van con `ghosty-studio[bot]`, así que se ven a la legua. Un issue o un
 * comentario **no**: los escribe el token del usuario y en GitHub aparecen indistinguibles de
 * lo que tecleó él. Y no es paranoia — a los tres meses ni el propio autor sabe cuál de sus
 * issues redactó a mano.
 *
 * La atribución no cambia y es correcta: la persona pidió el texto y responde por él. Lo que
 * añade esto es la PROCEDENCIA, que es otra cosa.
 *
 * Va en cursiva y al final para que no compita con el contenido. Deliberadamente NO dice qué
 * modelo ni qué versión: eso envejece mal y no le importa a quien lo lee.
 */
export function agentTrailer(): string {
  return "\n\n<sub><i>Redactado por Ghosty a petición del autor.</i></sub>";
}
