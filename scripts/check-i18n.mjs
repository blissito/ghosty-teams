#!/usr/bin/env node
// ¿Está TODO el copy traducido al inglés?
//
// Existe porque `i18n.en.ts` se editaba a mano y nadie comprobaba nada: el 2026-08-04 el
// 23.5% de las llamadas a t() caían al fallback español —o sea, se veían en español con la
// app en inglés— y el propio encabezado del diccionario decía "421 keys" cuando tenía 665.
// Un diccionario no falla: se queda corto en silencio.
//
// Uso:  npm run check:i18n           → falla si hay claves sin traducir
//       npm run check:i18n -- --json → sólo la lista, para volcarla al diccionario
//       npm run check:i18n -- --orphans → las que sobran (revísalas a mano antes de borrar)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// Un literal de JS, con sus escapes. Se acepta comilla doble y simple; NO backtick: una
// plantilla con ${} no es una clave estable y no debería llegar a t().
const LITERAL = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;
// `t(` y `tr(` como llamada, no como sufijo de otro identificador (`format(`, `fmt(`).
const CALL = new RegExp(String.raw`(?<![\w$.])tr?\(\s*(?:${LITERAL})`, "g");

function unescape(s) {
  return s.replace(/\\(["'\\nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
}

// Los comentarios se quitan ANTES de buscar: varios documentan el uso con un ejemplo
// (`t("texto en español", { params })` en i18n.tsx) y ese ejemplo no es copy que traducir.
// Se sustituyen por espacios, no se borran, para no pegar tokens de líneas distintas.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
}

const used = new Map(); // clave → [archivos]
for (const file of walk(SRC)) {
  const code = stripComments(readFileSync(file, "utf8"));
  for (const m of code.matchAll(CALL)) {
    const key = unescape(m[1] ?? m[2] ?? "");
    if (!key.trim()) continue;
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(file.slice(ROOT.length));
  }
}

// ── Claves DINÁMICAS ────────────────────────────────────────────────────────────
// `ToolGroup` hace `tr(t.label)`: la clave no está en la llamada, está en la tabla que la
// produjo. Un extractor puramente sintáctico las perdería TODAS —son ~180, las que se ven
// en cada turno del agente— y el check pasaría en verde mintiendo.
const AGENTS = readFileSync(join(SRC, "agents.server.ts"), "utf8");
const TABLE = AGENTS.match(/const TOOL_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!TABLE) {
  console.error("✗ no encontré TOOL_LABELS en agents.server.ts — ¿se renombró?");
  process.exit(2);
}
for (const m of TABLE[1].matchAll(/\b(?:ing|done):\s*"((?:[^"\\]|\\.)*)"/g)) {
  const key = unescape(m[1]);
  if (!used.has(key)) used.set(key, []);
  used.get(key).push("/src/agents.server.ts (TOOL_LABELS)");
}

// ── El diccionario ──────────────────────────────────────────────────────────────
// ⚠️ Una clave puede estar SIN comillas cuando es un identificador válido (`Aplicar: "Apply"`
// convive con `"Aplicar": "Apply"` unas líneas abajo). Leer sólo las entrecomilladas las daba
// por faltantes y al agregarlas TypeScript reventaba con "duplicate property".
const EN = readFileSync(join(SRC, "i18n.en.ts"), "utf8");
const have = new Set();
for (const m of EN.matchAll(new RegExp(String.raw`^\s*(?:${LITERAL}|([A-Za-z_$][\w$]*))\s*:`, "gm"))) {
  have.add(unescape(m[1] ?? m[2] ?? m[3] ?? ""));
}

const missing = [...used.keys()].filter((k) => !have.has(k)).sort();
const orphans = [...have].filter((k) => !used.has(k)).sort();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(missing, null, 2));
  process.exit(0);
}
if (process.argv.includes("--orphans")) {
  // NO se borran solas: algunas traducen texto que manda el SERVIDOR, donde la clave nunca
  // aparece dentro de un t(). Borrar por lista es como se pierde una traducción buena.
  console.log(`${orphans.length} claves en el diccionario sin uso estático:\n`);
  for (const k of orphans) console.log(`  ${JSON.stringify(k)}`);
  process.exit(0);
}

const pct = used.size ? Math.round(((used.size - missing.length) / used.size) * 100) : 100;
console.log(`i18n · ${used.size} claves en uso · ${have.size} en el diccionario · ${pct}% traducido`);

if (!missing.length) {
  console.log("✓ todo el copy tiene traducción al inglés");
  process.exit(0);
}

console.log(`\n✗ ${missing.length} sin traducir (se verían en ESPAÑOL con la app en inglés):\n`);
for (const k of missing.slice(0, 40)) {
  console.log(`  ${JSON.stringify(k)}  ← ${used.get(k)[0]}`);
}
if (missing.length > 40) console.log(`  … y ${missing.length - 40} más (usa --json para la lista completa)`);
process.exit(1);
