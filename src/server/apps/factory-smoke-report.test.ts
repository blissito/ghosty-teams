import { describe, expect, it } from "vitest";
import { pageIssuesText, reportFromGs } from "./factory-smoke.server";

describe("smoke completo de gs (22-nov)", () => {
  it("normaliza página y Lighthouse y deja los pasos en el contrato de siempre", () => {
    const r = reportFromGs({
      steps: [
        { method: "GET", path: "/", status: 200, ok: true, why: "200" },
        { method: "POST", path: "/_root.data", status: 403, ok: false, why: "403: origen" },
      ],
      page: { brokenImages: 1, layout: 1, contrastFails: 2, contrastRan: false, issues: [{ kind: "image", what: "/img/csv.svg", where: "celular" }] },
      lighthouse: { performance: 94.4, accessibility: 88, bestPractices: null, seo: 71 },
    });
    expect(r.results).toEqual([{ path: "/_root.data", method: "POST", status: 403, ok: false, why: "403: origen" }]);
    expect(r.lighthouse).toEqual({ performance: 94, accessibility: 88, bestPractices: null, seo: 71 });
    expect(r.page?.issues).toHaveLength(1);
  });

  it("sin página ni Lighthouse (gs viejo) no truena", () => {
    expect(reportFromGs({ steps: [] })).toEqual({ results: null, page: null, lighthouse: null });
  });

  it("el texto para el escritor omite el contraste que no corrió", () => {
    const txt = pageIssuesText({
      brokenImages: 1, layout: 0, contrastFails: 1, contrastRan: false,
      issues: [{ kind: "image", what: "/img/a.png", where: "celular" }, { kind: "contrast", what: "«Hola» 2:1", where: "" }],
    });
    expect(txt).toBe("- imagen rota: /img/a.png (celular)");
  });
});
