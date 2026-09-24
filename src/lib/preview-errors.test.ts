import { describe, it, expect } from "vitest";
import { diagnosePreview } from "./preview-errors";

describe("diagnóstico de la preview", () => {
  it("OOM del build: causa clara y sin stack nativo", () => {
    const d = diagnosePreview(
      "falló el build (npm run build)\nvite v5 building...\n<--- JS stacktrace --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n 1: 0xe46bbe node::OOMErrorHandler\n 2: 0x1243640 v8::Utils",
    );
    expect(d.step).toBe("build");
    expect(d.cause).toBe("El build se quedó sin memoria");
    expect(d.log).toContain("FATAL ERROR");
    expect(d.log).not.toContain("0xe46bbe");
    expect(d.log).not.toContain("JS stacktrace");
  });

  it("base de datos inalcanzable apunta a Variables", () => {
    const d = diagnosePreview("la app se cayó al arrancar (npm run start)\nPrismaClientInitializationError: P1001: Can't reach database server");
    expect(d.step).toBe("start");
    expect(d.cause).toBe("La app no alcanza su base de datos");
    expect(d.envRelated).toBe(true);
  });

  it("sin regla conocida: el paso y un consejo genérico", () => {
    const d = diagnosePreview("falló la instalación (npm ci)\nnpm ERR! 404 Not Found - @acme/privado");
    expect(d.step).toBe("install");
    expect(d.cause).toBe("Falló el paso «Instalación»");
  });
});
