// ── T3 · detector de tokens muertos ─────────────────────────────────────────
//
// El bug de fondo del brand kit fue que EMITIR y CONSUMIR eran dos actos sin ligadura:
// se emitían `--radius-DEFAULT` (nombre inventado), `--radius-brand` (nadie lo usa),
// `--pr-paper` y, en el PDF, `--shadow` y `--caps` — todos muertos, y ningún test lo vio.
//
// Este archivo cruza el REGISTRO de tokens contra el CSS real de cada superficie, en las
// dos direcciones. Si alguien añade un token y olvida consumirlo, o escribe una regla que
// usa un token que nadie emite (y se queda callada usando el fallback), esto falla.

import { describe, expect, it } from "vitest";
import { compile } from "tailwindcss";
import { TAILWIND_INDEX_CSS } from "#/server/tailwind-index-css";
import { BRAND_TOKENS, brandThemeCss, emit, type BrandKit, type BrandSurface } from "./brand-tokens";
import { FORM_CSS } from "#/server/forms/render.server";
import { PRINT_CSS } from "#/server/doc-export.server";

const KIT: BrandKit = {
  id: "k",
  name: "K",
  colors: { primary: "#7c3aed", secondary: "#a78bfa", accent: "#f59e0b", surface: "#ffffff" },
  mood: "bold",
};

/**
 * El CSS donde se puede COMPROBAR el consumo de cada superficie.
 *
 * `artifact` y `app` no tienen un CSS propio en el repo: sus consumidores son las
 * utilidades de Tailwind, así que el corpus es el CSS compilado con un juego amplio de
 * candidatos. Si un token de esas superficies no aparece ahí, es que Tailwind no lo
 * conoce — exactamente el caso de `--radius-DEFAULT`.
 */
async function corpusFor(surface: BrandSurface): Promise<string> {
  if (surface === "form") return FORM_CSS;
  if (surface === "print") return PRINT_CSS;
  const candidates = [
    "rounded", "rounded-xs", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl",
    "rounded-2xl", "rounded-3xl", "rounded-4xl",
    "bg-brand", "bg-brand-2", "text-brand-fg", "bg-surface", "bg-surface-2", "bg-surface-3",
    "border-border", "text-ink", "text-muted", "font-sans", "font-serif",
    // Lo que un artefacto del agente usaría: acento, señales y la serie de gráficas.
    "bg-accent", "text-danger", "bg-success", "text-warn",
    "bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5",
  ];
  const c = await compile(`${brandThemeCss(KIT)}\n${TAILWIND_INDEX_CSS}`, { base: "/" });
  return c.build(candidates);
}

const SURFACES: BrandSurface[] = ["form", "print", "artifact", "app"];

describe("cada token emitido tiene un consumidor real", () => {
  for (const surface of SURFACES) {
    it(`superficie "${surface}": ningún token muerto`, async () => {
      const css = await corpusFor(surface);
      const declarados = BRAND_TOKENS.filter((t) => t.surfaces.includes(surface));
      expect(declarados.length, `la superficie ${surface} no declara ningún token`).toBeGreaterThan(0);
      const muertos = declarados
        .map((t) => t.name)
        // Un token se considera vivo si alguien lo LEE (`var(--x`) o —en las superficies
        // de Tailwind— si el compilador generó una utilidad que lo referencia.
        .filter((name) => !css.includes(`var(${name})`) && !css.includes(`var(${name},`));
      expect(muertos, `emitidos en "${surface}" y nunca leídos: ${muertos.join(", ")}`).toEqual([]);
    });
  }
});

describe("cada var de marca leída en el CSS existe en el registro", () => {
  // La dirección inversa: una regla que usa `var(--radio-de-tarjeta, 12px)` se ve bien en
  // pantalla —usa el fallback— y nunca reacciona a la marca. Es un fallo silencioso.
  const nombresDelRegistro = new Set(BRAND_TOKENS.map((t) => t.name));

  for (const [label, css] of [
    ["formulario", FORM_CSS],
    ["PDF", PRINT_CSS],
  ] as const) {
    it(`${label}: sin vars huérfanas`, () => {
      const leidas = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
      // Las vars de la propia app (--color-*, --font-sans) no son del kit: se excluyen.
      const huerfanas = [...leidas].filter(
        (v) => !nombresDelRegistro.has(v as `--${string}`) && !v.startsWith("--color-") && v !== "--font-sans"
      );
      expect(huerfanas, `leídas en ${label} pero nadie las emite: ${huerfanas.join(", ")}`).toEqual([]);
    });
  }
});

describe("emit() es coherente con el registro", () => {
  for (const surface of SURFACES) {
    it(`emit(kit, "${surface}") devuelve exactamente lo declarado`, () => {
      const out = emit(KIT, surface);
      const esperados = BRAND_TOKENS.filter((t) => t.surfaces.includes(surface)).map((t) => t.name).sort();
      expect(Object.keys(out).sort()).toEqual(esperados);
    });
  }

  it("ningún token se declara sin superficies", () => {
    const sueltos = BRAND_TOKENS.filter((t) => t.surfaces.length === 0).map((t) => t.name);
    expect(sueltos).toEqual([]);
  });

  it("los nombres no se repiten", () => {
    const nombres = BRAND_TOKENS.map((t) => t.name);
    expect(new Set(nombres).size).toBe(nombres.length);
  });
});
