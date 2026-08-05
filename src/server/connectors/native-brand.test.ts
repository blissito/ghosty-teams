import { describe, expect, it } from "vitest";
import { BRAND_FONTS } from "#/lib/brand-fonts";
import { BRAND_MOODS } from "#/lib/brand-tokens";
import { nativeTools } from "./native.server";

// El agente sólo puede acertar lo que ve en el schema. Estas comprobaciones existen
// porque el saneador de fuentes descarta un id desconocido EN SILENCIO: si el catálogo
// no viaja en la descripción, el modelo manda "Playfair Display" (el nombre bonito),
// no pasa nada, y responde que ya lo cambió.
const tools = nativeTools(null);
const byName = (n: string) => tools.find((t) => t.name === n);

describe("tools de marca del agente", () => {
  it("existen las cinco", () => {
    for (const n of ["brand_list", "brand_extract", "brand_activate", "brand_update", "brand_set_logo"]) {
      expect(byName(n), `falta ${n}`).toBeTruthy();
    }
  });

  it("brand_update expone el catálogo de fuentes en el schema", () => {
    const props = byName("brand_update")!.inputSchema as {
      properties: Record<string, { description?: string; enum?: string[] }>;
    };
    for (const campo of ["headingFont", "bodyFont"]) {
      const d = props.properties[campo]?.description ?? "";
      for (const f of BRAND_FONTS) {
        expect(d, `${campo} no menciona "${f.id}"`).toContain(f.id);
      }
    }
  });

  it("brand_update expone los tonos como enum, no como texto libre", () => {
    const props = byName("brand_update")!.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(props.properties.mood?.enum?.slice().sort()).toEqual([...BRAND_MOODS].sort());
  });

  it("se puede cambiar cada color por separado", () => {
    const props = byName("brand_update")!.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const c of ["primary", "secondary", "accent", "surface"]) {
      expect(props.properties[c], `falta ${c}`).toBeTruthy();
    }
    // Sólo el id es obligatorio: mandar un color no puede exigir mandar los otros tres.
    expect(props.required).toEqual(["id"]);
  });
});
