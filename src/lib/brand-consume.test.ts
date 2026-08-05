// ── Tests de CONSUMO ────────────────────────────────────────────────────────
//
// ⚠️ Existen por un error de método que costó tres rondas: los tests anteriores
// comprobaban EMISIÓN (que `brandThemeCss` contuviera tal cadena) y pasaban en verde
// mientras el token emitido —`--radius-DEFAULT`— era un nombre INVENTADO que Tailwind
// ignora. Emitir y consumir son dos actos distintos; sólo el segundo se ve en pantalla.
//
// Regla: un token de marca no está "hecho" hasta que un consumidor real lo resuelve.
// Aquí se compila Tailwind de verdad y se lee el CSS que de verdad se hornea.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "tailwindcss";
import { TAILWIND_INDEX_CSS } from "#/server/tailwind-index-css";
import { brandRadiusScale, brandThemeCss, type BrandKit } from "./brand-tokens";
import { FORM_CSS } from "#/server/forms/render.server";
import { PRINT_CSS } from "#/server/doc-export.server";

const kit = (mood: BrandKit["mood"]): BrandKit => ({
  id: "k",
  name: "K",
  colors: { primary: "#7c3aed", secondary: "#a78bfa", accent: "#f59e0b", surface: "#ffffff" },
  mood,
});

/** Compila un CSS con Tailwind y devuelve las utilidades pedidas. */
async function build(prelude: string, candidates: string[]): Promise<string> {
  const c = await compile(`${prelude}\n${TAILWIND_INDEX_CSS}`, { base: "/" });
  return c.build(candidates);
}

/** `border-radius` resuelto de una utilidad, tal cual sale del compilador. */
function radiusOf(css: string, util: string): string | null {
  const m = css.match(new RegExp(`\\.${util}\\s*\\{([^}]*)\\}`));
  return m?.[1].match(/border-radius:\s*([^;]+)/)?.[1].trim() ?? null;
}

describe("T1 · el radio de marca llega a las utilidades de Tailwind", () => {
  it("`rounded` a secas resuelve a var(--radius)", async () => {
    // ⚠️ Éste es el test que faltaba. En Tailwind v4 `--radius` vive en un bloque
    // `@theme default inline reference`: mientras nadie lo DECLARE, su valor se incrusta
    // (`border-radius: 0.25rem`) y ningún override en runtime lo alcanza. Declararlo es
    // lo que lo saca de ese modo.
    const css = await build(brandThemeCss(kit("playful")), ["rounded"]);
    expect(radiusOf(css, "rounded")).toBe("var(--radius)");
  });

  it("los escalones de la rampa salen con el valor del kit", async () => {
    const k = kit("playful");
    const scale = brandRadiusScale(k);
    const css = await build(brandThemeCss(k), ["rounded-lg", "rounded-xl", "rounded-2xl"]);
    // La utilidad SIEMPRE referencia la var; lo que hay que comprobar es que el
    // `:root` emitido traiga el valor del kit y no el de fábrica.
    expect(radiusOf(css, "rounded-lg")).toBe("var(--radius-lg)");
    expect(css).toContain(`--radius-lg: ${scale.lg}px`);
    expect(css).toContain(`--radius-xl: ${scale.xl}px`);
  });

  it("rounded-full es INMUNE al tono — un avatar cuadrado se ve roto", async () => {
    for (const m of ["elegant", "playful"] as const) {
      const css = await build(brandThemeCss(kit(m)), ["rounded-full"]);
      expect(radiusOf(css, "rounded-full")).toBe("calc(infinity * 1px)");
    }
  });

  it("dos tonos opuestos dan radios distintos de verdad", async () => {
    const sharp = brandRadiusScale(kit("elegant"));
    const round = brandRadiusScale(kit("playful"));
    expect(sharp.lg).toBe(0);
    expect(round.lg).toBeGreaterThan(sharp.lg + 6);
  });

  it("sin kit no se toca nada: `rounded` sigue siendo el de fábrica", async () => {
    const css = await build("", ["rounded"]);
    expect(radiusOf(css, "rounded")).toBe("0.25rem");
  });
});

describe("T1b · la app: styles.css tiene que declarar --radius", () => {
  it("el @theme de la app declara --radius, o el override de /api/brand-css no alcanza", () => {
    // Sin esta declaración, los ~48 `rounded` pelados de la app compilan a un literal y
    // la hoja de marca no puede pisarlos. Es un requisito del BUILD, no del runtime.
    // Se quitan los comentarios ANTES de recortar el bloque: un `}` dentro de un
    // comentario cortaba el slice a media declaración y el test mentía.
    const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const theme = css.slice(css.indexOf("@theme"), css.indexOf("}", css.indexOf("@theme")));
    expect(theme).toMatch(/--radius\s*:/);
  });
});

describe("T2 · el tono cambia el CSS que de verdad se hornea", () => {
  // ⚠️ El assert perezoso `htmlA !== htmlB` NO vale: pasa hoy, porque los colores ya
  // cambian. Tiene que ser sobre la familia de radio específicamente.
  const radiiIn = (css: string) => [...css.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());

  it("el formulario referencia la rampa y no números sueltos", () => {
    const fijos = radiiIn(FORM_CSS).filter((v) => !v.startsWith("var(") && v !== "99px" && v !== "50%");
    // 99px/50% son círculos intencionales (la palomita, la barra de progreso).
    expect(fijos, `radios fijos en el CSS del formulario: ${fijos.join(", ")}`).toEqual([]);
  });

  it("el PDF referencia la rampa y no números sueltos", () => {
    const fijos = radiiIn(PRINT_CSS).filter((v) => !v.startsWith("var("));
    expect(fijos, `radios fijos en PRINT_CSS: ${fijos.join(", ")}`).toEqual([]);
  });

  it("todo borde del formulario respeta el grosor del tono", () => {
    const bordes = [...FORM_CSS.matchAll(/border(?:-top|-bottom|-left|-right)?:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => v !== "0" && !v.startsWith("var(") && !/^0\s/.test(v));
    expect(bordes, `bordes con grosor fijo: ${bordes.join(" | ")}`).toEqual([]);
  });
});
