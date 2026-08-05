// ── T5 · la fuente se CARGA, no sólo se nombra ──────────────────────────────
//
// Gemelo de T1 pero para tipografía. El bug era idéntico: se guardaba "Playfair Display",
// se emitía `font-family:"Playfair Display"` y NADIE cargaba el archivo, así que el
// navegador pedía una familia que el visitante no tiene y caía al respaldo en silencio.
//
// Regla: si una superficie NOMBRA una familia de marca, tiene que EMITIR su @font-face.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_FONTS } from "./brand-fonts";
import { brandFaceCss, brandFaces, brandFontStacks, brandThemeCss, type BrandKit } from "./brand-tokens";
import { renderFormHtml } from "#/server/forms/render.server";

const withFont = (fonts: BrandKit["fonts"]): BrandKit => ({
  id: "k",
  name: "Kit",
  colors: { primary: "#7c3aed", secondary: "#a78bfa", accent: "#f59e0b", surface: "#ffffff" },
  fonts,
  mood: "elegant",
});

describe("el catálogo existe en disco", () => {
  // Un id del catálogo que no tenga archivo es una fuente que nunca va a cargar. Este
  // test es el que convierte el registro en una promesa comprobable.
  for (const f of BRAND_FONTS) {
    it(`${f.id} → public/fonts/${f.file}`, () => {
      expect(existsSync(`public/fonts/${f.file}`), `falta public/fonts/${f.file}`).toBe(true);
    });
  }

  it("los ids y las familias no se repiten", () => {
    expect(new Set(BRAND_FONTS.map((f) => f.id)).size).toBe(BRAND_FONTS.length);
    expect(new Set(BRAND_FONTS.map((f) => f.family)).size).toBe(BRAND_FONTS.length);
  });
});

describe("nombrar implica cargar", () => {
  it("una fuente del catálogo produce su @font-face", () => {
    const kit = withFont({ heading: "playfair", body: "dm-sans" });
    const faces = brandFaces(kit);
    expect(faces.map((f) => f.family).sort()).toEqual(["DM Sans", "Playfair Display"]);
    const css = brandFaceCss(kit);
    expect(css).toContain('@font-face');
    expect(css).toContain("/fonts/playfair.woff2");
    expect(css).toContain("/fonts/dm-sans.woff2");
  });

  it("una fuente SUBIDA gana sobre el catálogo y también carga", () => {
    const kit = withFont({ heading: "playfair", headingUrl: "https://x/t3/mia.woff2" });
    const css = brandFaceCss(kit);
    expect(css).toContain("https://x/t3/mia.woff2");
    expect(css).not.toContain("playfair.woff2");
    expect(brandFontStacks(kit).heading).toContain("GT Brand Heading");
  });

  it("sin fuente elegida no se emite ninguna cara", () => {
    expect(brandFaces(withFont({})).length).toBe(0);
    expect(brandFaceCss(withFont(undefined))).toBe("");
  });

  it("una sola cara si las dos ranuras usan la misma familia", () => {
    expect(brandFaces(withFont({ heading: "lora", body: "lora" })).length).toBe(1);
  });

  // ⚠️ El corazón del test: toda familia nombrada en el `font-family` tiene que tener su
  // @font-face en el MISMO CSS. Es lo que fallaba en las cuatro superficies.
  const familiasNombradas = (stack: string) => [...stack.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it("el formulario público carga lo que nombra", () => {
    const kit = withFont({ heading: "playfair", body: "work-sans" });
    const html = renderFormHtml({
      title: "T",
      fields: [{ name: "a", label: "A", type: "text" }],
      submitUrl: "https://x/s",
      uploadUrl: "https://x/u",
      brand: kit,
    });
    for (const fam of familiasNombradas(brandFontStacks(kit).heading).concat(
      familiasNombradas(brandFontStacks(kit).body)
    )) {
      // Las de respaldo del sistema no llevan @font-face; sólo las del catálogo/subidas.
      const def = BRAND_FONTS.find((f) => f.family === fam);
      if (!def) continue;
      // ⚠️ Assert sobre la CARGA, no sobre el nombre. `font-family:"Playfair Display"`
      // aparece por el simple hecho de nombrarla — que es exactamente el bug. Lo que hay
      // que exigir es el @font-face y su archivo.
      const face = html.match(new RegExp(`@font-face\\{[^}]*"${fam}"[^}]*\\}`));
      expect(face, `el formulario nombra "${fam}" sin emitir su @font-face`).not.toBeNull();
      expect(face![0], `el @font-face de "${fam}" no apunta a su archivo`).toContain(def.file);
    }
  });

  it("el @theme del artefacto trae las caras", () => {
    const kit = withFont({ heading: "playfair", body: "work-sans" });
    const css = brandThemeCss(kit);
    expect(css).toContain('@font-face');
    expect(css).toContain("Playfair Display");
    expect(css).toContain("Work Sans");
  });
});
