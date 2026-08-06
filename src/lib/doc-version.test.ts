import { afterEach, describe, expect, it, vi } from "vitest";
import { avisarVersion } from "./doc-version";

const res = (v?: string) => new Response(null, { headers: v ? { "X-Doc-Version": v } : {} });

afterEach(() => vi.restoreAllMocks());

describe("avisarVersion", () => {
  it("avisa cuando el servidor sirvió OTRA versión de la pedida", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    avisarVersion(res("12"), 11);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("calla cuando coinciden — incluso si una es número y la otra texto", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    avisarVersion(res("11"), 11);
    avisarVersion(res("11"), "11");
    expect(warn).not.toHaveBeenCalled();
  });

  it("calla si no se pidió versión: ahí 'la última' ES el contrato", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    avisarVersion(res("12"), null);
    avisarVersion(res("12"), "");
    // Y si el endpoint es viejo y no manda el header, tampoco hay nada que comparar.
    avisarVersion(res(), 11);
    expect(warn).not.toHaveBeenCalled();
  });
});
