import { describe, it, expect } from "vitest";
import { toolEnScope } from "./tools.server";
import { isStudioTool } from "./studio-bridge.server";

describe("conectores de Ghosty Studio en Teams (Drive)", () => {
  it("son de gs sólo los prefijos reservados", () => {
    expect(isStudioTool("drive_leer")).toBe(true);
    expect(isStudioTool("hoja_agregar_fila")).toBe(true);
    expect(isStudioTool("doc_read")).toBe(false);
  });
  it("con alcance de lectura se lee, pero no se escribe en el archivo", () => {
    const lectura = new Set(["lectura"]) as any;
    expect(toolEnScope("drive_leer", lectura)).toBe(true);
    expect(toolEnScope("drive_archivos", lectura)).toBe(true);
    expect(toolEnScope("hoja_actualizar", lectura)).toBe(false);
    expect(toolEnScope("documento_agregar", new Set(["codigo"]) as any)).toBe(false);
    expect(toolEnScope("hoja_actualizar", new Set(["completo"]) as any)).toBe(true);
  });
});
