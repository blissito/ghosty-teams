// Crear el brand kit de un workspace desde fuera del panel.
//
// Existe para el onboarding: la marca de un cliente sale de su manual de imagen (un PDF
// de 34 MB, colores Pantone, tipografías) y eso se saca UNA vez, con calma, no tecleando
// hex en un formulario mientras alguien espera.
//
// ⚠️ Corre dentro de `withNamespace`: `createBrandKit` escribe con `dbq`, que resuelve el
// tenant del CONTEXTO de la request. Fuera de una request cae a `SQLD_NAMESPACE`, o sea
// que la marca del cliente aterrizaría en otro workspace sin un solo error.
//
// Uso: node crear-marca.mjs <ns> <config.json> [logo.png]
import { withNamespace } from "../src/server/tenant.server";
import { createBrandKit, putLogo } from "../src/server/brand.server";
import fs from "node:fs/promises";

const [ns, archivo, logoPath] = process.argv.slice(2);
if (!ns || !archivo) {
  console.error("uso: node crear-marca.mjs <ns> <config.json> [logo.png]");
  process.exit(1);
}
const cfg = JSON.parse(await fs.readFile(archivo, "utf8"));

const kit = await withNamespace(ns, async () => {
  let logoKey: string | null = null;
  if (logoPath) {
    const bytes = await fs.readFile(logoPath);
    const name = logoPath.split("/").pop()!;
    const tipo = name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".jpg") ? "image/jpeg" : "image/png";
    logoKey = await putLogo(new Blob([bytes], { type: tipo }), name, tipo);
    console.log(`  logo → ${logoKey}`);
  }
  return createBrandKit({ ...cfg, logoKey }, cfg.createdBy ?? "ops", ns);
});

console.log(JSON.stringify({ id: kit.id, name: kit.name, colors: kit.colors, fonts: kit.fonts, logoUrl: kit.logoUrl }, null, 2));
