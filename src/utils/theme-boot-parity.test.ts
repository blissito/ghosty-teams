// @vitest-environment jsdom
//
// ── THEME_BOOT ≡ applyTheme ──────────────────────────────────────────────────
// El tema se aplica DOS veces con dos implementaciones distintas: `applyTheme` (TS, tras
// hidratar) y `THEME_BOOT` (un string de JS ES5 que corre en el <head> antes del primer
// paint, y que existe para que no haya FOUC). Escribir la misma regla dos veces es la
// única forma de no tener FOUC, pero cualquier arreglo que se haga en una y no en la otra
// se ve como un parpadeo al cargar — o directamente no se ve, y se diagnostica como que
// el ajuste "no se guardó".
//
// El bug que originó este test vivía en LAS DOS: el preset por default cedía ante la hoja
// de marca del workspace, así que la elección personal de cada quien se perdía. Se arregló
// en las dos a mano; esto es lo que impide que la próxima se arregle sólo en una.
//
// No se comparan implementaciones, se compara el EFECTO sobre <html>.

import { describe, it, expect, beforeEach } from "vitest";
import { THEME_BOOT, applyTheme, type ThemeState, PRESETS, BRAND_PRESET_ID } from "./theme";

function effect(run: () => void): { attrs: Record<string, string | null>; style: Record<string, string> } {
  const r = document.documentElement;
  r.removeAttribute("data-theme");
  r.removeAttribute("data-preset");
  r.removeAttribute("data-reduce-motion");
  r.removeAttribute("style");
  run();
  const style: Record<string, string> = {};
  for (let i = 0; i < r.style.length; i++) style[r.style[i]] = r.style.getPropertyValue(r.style[i]);
  return {
    attrs: {
      "data-theme": r.getAttribute("data-theme"),
      "data-preset": r.getAttribute("data-preset"),
      "data-reduce-motion": r.getAttribute("data-reduce-motion"),
    },
    style,
  };
}

const KEYS = {
  preset: "gc.preset", scheme: "gc.scheme", textSize: "gc.textSize",
  font: "gc.font", reduceMotion: "gc.reduceMotion",
};

function seed(s: ThemeState): void {
  localStorage.clear();
  localStorage.setItem("gc.preset.v2", "1"); // la migración ya corrió: aquí se prueba el estado estable
  localStorage.setItem(KEYS.preset, s.preset);
  localStorage.setItem(KEYS.scheme, s.scheme);
  localStorage.setItem(KEYS.textSize, s.textSize);
  localStorage.setItem(KEYS.font, s.font);
  localStorage.setItem(KEYS.reduceMotion, s.reduceMotion ? "1" : "0");
}

const base: ThemeState = {
  preset: BRAND_PRESET_ID, scheme: "light", textSize: "regular",
  font: "default", reduceMotion: false, darkSidebar: false,
};

// Todos los presets × los dos modos × las variaciones que tocan ramas distintas.
const CASES: ThemeState[] = [
  ...[BRAND_PRESET_ID, ...PRESETS.map((p) => p.id)].flatMap((preset) => [
    { ...base, preset },
    { ...base, preset, scheme: "dark" as const },
  ]),
  { ...base, preset: "paper", font: "mono" },
  { ...base, preset: BRAND_PRESET_ID, font: "serif" },
  { ...base, preset: "ocean", textSize: "xl", reduceMotion: true },
  { ...base, preset: "no-existe" }, // un preset borrado del catálogo cae al mismo sitio en las dos
];

describe("THEME_BOOT hace exactamente lo mismo que applyTheme", () => {
  beforeEach(() => localStorage.clear());

  for (const s of CASES) {
    it(`${s.preset} · ${s.scheme} · ${s.font} · ${s.textSize}${s.reduceMotion ? " · reduce" : ""}`, () => {
      seed(s);
      const boot = effect(() => new Function(THEME_BOOT)());
      seed(s);
      const applied = effect(() => applyTheme(s));
      expect(boot.attrs).toEqual(applied.attrs);
      expect(boot.style).toEqual(applied.style);
    });
  }

  it("un preset personal SIEMPRE escribe la paleta inline — es lo que le gana a la marca del workspace", () => {
    seed({ ...base, preset: "ghosty" });
    const boot = effect(() => new Function(THEME_BOOT)());
    expect(boot.style["--color-brand"]).toBe("#7c3aed");
    expect(boot.attrs["data-preset"]).toBe("ghosty");
  });

  it("SÓLO 'Workspace' cede: no escribe ni un color, para que mande /api/brand-css", () => {
    seed({ ...base, preset: BRAND_PRESET_ID });
    const boot = effect(() => new Function(THEME_BOOT)());
    expect(Object.keys(boot.style).some((k) => k.startsWith("--color-"))).toBe(false);
    expect(boot.attrs["data-preset"]).toBe(null);
  });

  it("migra el 'ghosty' heredado a 'brand' una sola vez, y no vuelve a tocarlo", () => {
    localStorage.clear();
    localStorage.setItem(KEYS.preset, "ghosty"); // guardado por setThemePartial sin que nadie lo eligiera
    effect(() => new Function(THEME_BOOT)());
    expect(localStorage.getItem(KEYS.preset)).toBe(BRAND_PRESET_ID);
    // Y ahora que la migración corrió, elegir Ghosty a propósito se respeta.
    localStorage.setItem(KEYS.preset, "ghosty");
    effect(() => new Function(THEME_BOOT)());
    expect(localStorage.getItem(KEYS.preset)).toBe("ghosty");
  });
});
