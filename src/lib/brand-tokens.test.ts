import { describe, expect, it } from "vitest";
import {
  BRAND_MOODS,
  type BrandKit,
  brandFormVars,
  brandPalette,
  brandPrintVars,
  brandThemeCss,
  contrast,
  ensureContrast,
  isHex,
  normalizeColors,
  normalizeHex,
  onColor,
  slugToken,
} from "./brand-tokens";

const kit = (name: string, colors: Partial<BrandKit["colors"]>): BrandKit => ({
  id: name,
  name,
  colors: { primary: "#7c3aed", secondary: "#a78bfa", accent: "#f59e0b", surface: "#ffffff", ...colors },
});

// Casos que cubren lo que rompe en la vida real: marca oscura, marca clarísima
// (amarillo sobre blanco es el clásico), superficie oscura y gris sin color.
const KITS: BrandKit[] = [
  kit("claro", {}),
  kit("oscuro", { primary: "#22d3ee", secondary: "#0891b2", surface: "#0a2229" }),
  kit("amarillo", { primary: "#facc15", secondary: "#fde047", accent: "#f97316" }),
  kit("negro", { primary: "#000000", secondary: "#404040", surface: "#ffffff" }),
  kit("neon-sobre-negro", { primary: "#f0abfc", secondary: "#22d3ee", surface: "#0d0714" }),
  kit("gris", { primary: "#6b7280", secondary: "#9ca3af", accent: "#6b7280", surface: "#f5f5f5" }),
  // Un kit por tono: el tono mueve teñido, borde, contraste y familia, o sea que puede
  // romper el contraste igual que un color feo.
  ...BRAND_MOODS.map((m) => ({ ...kit(`tono-${m}`, {}), mood: m })),
  ...BRAND_MOODS.map((m) => ({
    ...kit(`tono-${m}-oscuro`, { primary: "#facc15", surface: "#0d0714" }),
    mood: m,
  })),
];

describe("hex", () => {
  it("acepta 3 y 6 dígitos y normaliza", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("  #7C3AED ")).toBe("#7c3aed");
  });

  it("rechaza lo que no es hex", () => {
    for (const bad of ["rojo", "#12", "#1234567", "rgb(0,0,0)", "", "#gggggg"]) {
      expect(isHex(bad)).toBe(false);
      expect(() => normalizeHex(bad)).toThrow();
    }
  });
});

describe("contraste", () => {
  it("los extremos conocidos de WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("ensureContrast alcanza el objetivo o ya lo cumplía", () => {
    // Amarillo sobre blanco: 1.07 de origen, lo tiene que empujar a oscuro.
    expect(contrast("#facc15", "#ffffff")).toBeLessThan(2);
    expect(contrast(ensureContrast("#facc15", "#ffffff", 4.5), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("no toca un color que ya cumple", () => {
    expect(ensureContrast("#000000", "#ffffff", 4.5)).toBe("#000000");
  });

  it("onColor elige el lado legible en los dos sentidos", () => {
    expect(contrast(onColor("#ffffff"), "#ffffff")).toBeGreaterThanOrEqual(7);
    expect(contrast(onColor("#0b0b0f"), "#0b0b0f")).toBeGreaterThanOrEqual(7);
  });
});

// Éste es el test que importa: es la regresión del bug de EasyBits (texto negro
// hardcodeado sobre fondo oscuro). Cada par texto/fondo de cada superficie, en
// los dos esquemas, tiene que pasar AA.
describe("todos los kits producen tokens legibles", () => {
  for (const k of KITS) {
    describe(k.name, () => {
      it("paleta de la app: AA en claro y en oscuro", () => {
        const p = brandPalette(k);
        for (const mode of ["light", "dark"] as const) {
          const pal = p[mode];
          expect(contrast(pal.ink, pal.surface), `ink/surface ${mode}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(pal.ink, pal["surface-2"]), `ink/surface-2 ${mode}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(pal.ink, pal["surface-3"]), `ink/surface-3 ${mode}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(pal.muted, pal.surface), `muted/surface ${mode}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(pal["brand-fg"], pal.brand), `brand-fg/brand ${mode}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(pal.brand, pal.surface), `brand/surface ${mode}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("el modo oscuro es realmente oscuro y el claro realmente claro", () => {
        const p = brandPalette(k);
        expect(contrast(p.dark.surface, "#ffffff")).toBeGreaterThan(contrast(p.light.surface, "#ffffff"));
      });

      it("formulario público: texto y acento legibles sobre el papel", () => {
        const v = brandFormVars(k);
        expect(contrast(v["--ink"], v["--paper"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--muted"], v["--paper"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--accent-ink"], v["--paper"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--req"], v["--paper"])).toBeGreaterThanOrEqual(4.5);
        // La barra de progreso pinta accent sobre tint: tiene que verse.
        expect(contrast(v["--accent"], v["--tint"])).toBeGreaterThanOrEqual(3);
      });

      it("PDF: el papel es blanco y el texto pasa AA", () => {
        const v = brandPrintVars(k);
        expect(v["--pr-paper"]).toBe("#ffffff");
        expect(contrast(v["--pr-ink"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--pr-muted"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--pr-brand"], v["--pr-tint"])).toBeGreaterThanOrEqual(3);
      });

      it("todo token emitido es un hex válido", () => {
        const all = { ...brandFormVars(k), ...brandPrintVars(k), ...brandPalette(k).light, ...brandPalette(k).dark };
        for (const [key, val] of Object.entries(all)) expect(isHex(val), `${key}=${val}`).toBe(true);
      });
    });
  }
});

// El tono NO puede ser una etiqueta inerte: si dos tonos derivan lo mismo, el control
// vuelve a estar muerto y nadie se entera.
describe("el tono cambia la derivación de verdad", () => {
  const base = kit("x", {});
  const of = (m: string | null) => brandPalette({ ...base, mood: m as never }).light;

  it("cada tono da una paleta distinta a la del vecino", () => {
    const firmas = BRAND_MOODS.map((m) => JSON.stringify(of(m)));
    expect(new Set(firmas).size).toBe(BRAND_MOODS.length);
  });

  it("minimal tiñe menos que vibrant", () => {
    expect(contrast(of("minimal")["surface-2"], "#ffffff")).toBeLessThan(
      contrast(of("vibrant")["surface-2"], "#ffffff")
    );
  });

  it("bold exige AAA a la marca sobre el fondo", () => {
    const b = of("bold");
    expect(contrast(b.brand, b.surface)).toBeGreaterThanOrEqual(7);
  });

  it("elegant cae en serif y professional en sans", () => {
    expect(brandPalette({ ...base, mood: "elegant" }).font).toBe("serif");
    expect(brandPalette({ ...base, mood: "professional" }).font).toBe("sans");
  });

  it("sin tono se comporta como professional", () => {
    expect(of(null)).toEqual(of("professional"));
  });
});

describe("@theme de artefactos", () => {
  it("emite las 9 vars, las fuentes y el bloque oscuro", () => {
    const css = brandThemeCss(kit("x", {}));
    expect(css).toContain("@theme");
    expect(css).toContain("--color-brand:");
    expect(css).toContain("--color-surface-3:");
    expect(css).toContain("--font-heading:");
    expect(css).toContain("prefers-color-scheme: dark");
  });

  it("los extras salen como tokens seguros y los hex basura se descartan", () => {
    const k = kit("x", {
      extras: [
        { name: "Rojo señal", hex: "#ff0000" },
        { name: "malo", hex: "azul" },
        { name: "", hex: "#00ff00" },
      ],
    });
    const css = brandThemeCss(k);
    expect(css).toContain("--color-x-rojo-senal: #ff0000;");
    expect(css).not.toContain("azul");
    expect(css).toContain("--color-x-extra: #00ff00;");
  });

  it("un nombre de extra no puede inyectar CSS", () => {
    const css = brandThemeCss(kit("x", { extras: [{ name: "a}; body{display:none", hex: "#123456" }] }));
    expect(css).not.toContain("display:none");
    expect(slugToken("a}; body{display:none")).toBe("x-a-body-display-none");
  });
});

describe("normalizeColors", () => {
  it("normaliza los cuatro y tope de extras", () => {
    const out = normalizeColors({
      primary: "#ABC", secondary: "#7C3AED", accent: "#f00", surface: "#FFF",
      extras: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, hex: "#010203" })),
    });
    expect(out.primary).toBe("#aabbcc");
    expect(out.accent).toBe("#ff0000");
    expect(out.extras).toHaveLength(12);
  });

  it("lanza si un color base no es hex — validación de borde", () => {
    expect(() => normalizeColors({ primary: "morado", secondary: "#fff", accent: "#fff", surface: "#fff" })).toThrow();
  });

  it("los moods son una sola lista", () => {
    expect(BRAND_MOODS).toContain("professional");
    expect(new Set(BRAND_MOODS).size).toBe(BRAND_MOODS.length);
  });
});
