// Mira o borra objetos del bucket privado de Teams, por clave.
//
// Existe porque las grabaciones de un evento son lo ÚNICO del room que no se ve desde
// ninguna UI y lo único que cuesta dinero: un ensayo de webinar deja gigas en Tigris que
// nadie vuelve a mirar. Borrar la fila de `gt_event_recordings` no toca el objeto.
//
// ⚠️ Se corre DENTRO de la caja de Teams (`files/write` a /tmp + `exec`), que es donde
// están las llaves de Tigris. Así no salen de ahí ni pasan por argv.
//
//   node tigris-purge.mjs <clave> [clave…]            → HEAD de cada una (no borra nada)
//   node tigris-purge.mjs --delete <clave> [clave…]   → borra
//   node tigris-purge.mjs --public …                  → contra el bucket público
//
// Receta completa de la limpieza (los 7 sitios donde queda residuo): memoria
// `howto_limpiar_room_de_evento`.
import crypto from "node:crypto";
import fs from "node:fs";

// El proceso de la caja tiene el env cargado, pero un `node` suelto por exec no: se lee
// el mismo archivo que systemd. Si ya viene en el env, gana el env.
const file = process.env.SECRETS_FILE ?? "/app/secrets.env";
const fromFile = fs.existsSync(file)
  ? Object.fromEntries(
      fs.readFileSync(file, "utf8").split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]))
  : {};
const env = { ...fromFile, ...process.env };

const ACCESS = env.TIGRIS_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
const SECRET = env.TIGRIS_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
const ENDPOINT = (env.STORAGE_ENDPOINT || "https://t3.storage.dev").replace(/\/$/, "");
const REGION = env.STORAGE_REGION || "auto";
const HOST = new URL(ENDPOINT).host;

const args = process.argv.slice(2);
const DELETE = args.includes("--delete");
const BUCKET = args.includes("--public")
  ? (env.STORAGE_BUCKET_PUBLIC || "ghosty-teams-public")
  : (env.STORAGE_BUCKET || "ghosty-teams");
const keys = args.filter((a) => !a.startsWith("--"));

if (!ACCESS || !SECRET) { console.error("faltan TIGRIS_ACCESS_KEY_ID / TIGRIS_SECRET_ACCESS_KEY"); process.exit(1); }
if (!keys.length) { console.error("uso: node tigris-purge.mjs [--delete] [--public] <clave>…"); process.exit(1); }

// URI-encode estilo AWS (RFC3986): encodeURIComponent deja pasar ! ' ( ) * y la firma
// no cuadra. `keepSlash` sólo para el path canónico.
const enc = (s, keepSlash = false) => {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/" && keepSlash) out += ch;
    else for (const b of Buffer.from(ch, "utf8")) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
};
const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hmac = (k, x) => crypto.createHmac("sha256", k).update(x).digest();

function presign(method, key, ttl = 300) {
  const amz = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amz.slice(0, 8);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const path = "/" + enc(BUCKET, true) + "/" + enc(key, true);
  const qs = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${ACCESS}/${scope}`],
    ["X-Amz-Date", amz],
    ["X-Amz-Expires", String(ttl)],
    ["X-Amz-SignedHeaders", "host"],
  ].map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join("&");
  const canonical = [method, path, qs, `host:${HOST}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonical)].join("\n");
  const signing = hmac(hmac(hmac(hmac("AWS4" + SECRET, day), REGION), "s3"), "aws4_request");
  return `${ENDPOINT}${path}?${qs}&X-Amz-Signature=${crypto.createHmac("sha256", signing).update(toSign).digest("hex")}`;
}

console.log(`bucket=${BUCKET} modo=${DELETE ? "BORRAR" : "sólo mirar"}`);
let bytes = 0, gone = 0;
for (const key of keys) {
  const head = await fetch(presign("HEAD", key), { method: "HEAD" });
  const size = Number(head.headers.get("content-length") || 0);
  if (head.status === 200) bytes += size;
  console.log(`${head.status === 200 ? "existe " + (size / 1e6).toFixed(1) + " MB" : "NO está (" + head.status + ")"}  ${key}`);
  if (DELETE && head.status === 200) {
    const r = await fetch(presign("DELETE", key), { method: "DELETE" });
    // Tigris responde 204 al borrar y 204 también si ya no estaba.
    console.log(`   → DELETE ${r.status} ${r.ok || r.status === 404 ? "ok" : await r.text()}`);
    if (r.ok || r.status === 404) gone++;
  }
}
console.log(DELETE ? `\n${gone} borrados, ${(bytes / 1e9).toFixed(2)} GB liberados` : `\n${(bytes / 1e9).toFixed(2)} GB en total`);
