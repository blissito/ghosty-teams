import { mapHeader, looksLikeHeader } from "../src/lib/prospeccion-mapping";
let f = 0;
const c = (l: string, ok: boolean, e = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${e ? ` — ${e}` : ""}`); if (!ok) f++; };

console.log("\n── Mapeo de encabezados ──");
c("Nombre → name", mapHeader("Nombre") === "name");
c("NOMBRE DEL NEGOCIO → name", mapHeader("NOMBRE DEL NEGOCIO") === "name", String(mapHeader("NOMBRE DEL NEGOCIO")));
c("Razón Social → name", mapHeader("Razón Social") === "name", String(mapHeader("Razón Social")));
c("Teléfono → phone", mapHeader("Teléfono") === "phone");
c("Tel. de contacto → phone", mapHeader("Tel. de contacto") === "phone", String(mapHeader("Tel. de contacto")));
c("Celular → phone", mapHeader("Celular") === "phone");
c("WhatsApp → phone", mapHeader("WhatsApp") === "phone");
c("Correo electrónico → email", mapHeader("Correo electrónico") === "email");
c("E-mail → email", mapHeader("E-mail") === "email", String(mapHeader("E-mail")));
c("Sitio Web → website", mapHeader("Sitio Web") === "website");
c("Dirección → address", mapHeader("Dirección") === "address");
c("Giro → category", mapHeader("Giro") === "category");
c("«Presupuesto» NO mapea (columna nueva)", mapHeader("Presupuesto") === null, String(mapHeader("Presupuesto")));
c("«Notas» NO mapea", mapHeader("Notas") === null);
c("vacío NO mapea", mapHeader("  ") === null);

c("Total NO cruza como teléfono", mapHeader("Total") === null, String(mapHeader("Total")));
c("Cliente → name (no phone)", mapHeader("Cliente") === "name", String(mapHeader("Cliente")));
c("Número de empleados NO es teléfono", mapHeader("Número de empleados") === null, String(mapHeader("Número de empleados")));

c("Número de teléfono → phone", mapHeader("Número de teléfono") === "phone", String(mapHeader("Número de teléfono")));

console.log("\n── ¿Hay cabecera? ──");
c("sheet con cabecera normal", looksLikeHeader(["Nombre", "Teléfono", "Correo"]) === true);
c("sheet SIN cabecera (datos en la 1ª row)", looksLikeHeader(["Dental Reforma", "55 1234 5678", "hola@dental.mx"]) === false);
c("cabecera rara pero sin datos → se trata como cabecera", looksLikeHeader(["Col A", "Col B"]) === true);
c("una sola columna de emails sin cabecera", looksLikeHeader(["ana@x.mx"]) === false);

console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}`);
process.exit(f ? 1 : 0);
