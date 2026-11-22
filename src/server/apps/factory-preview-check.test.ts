import { describe, it, expect } from "vitest";
import { previewCheckFrom } from "./factory-preview-check";
import { aggregateChecks } from "../connectors/github-checks";

const base = {
  id: 96,
  required: true,
  repoOff: false,
  preview: { state: "ready" as const, sha: "abc" as string | null, url: "https://pr-7.preview.test" },
  headSha: "abc",
  smokeFail: null as string | null,
  skippedBy: null as string | null,
  threadUrl: "https://denik.teams.ghosty.studio/c/fabrica?thread=1&run=96",
  envUrl: "https://denik.teams.ghosty.studio/factory?repo=denik%2Fagenda",
  openUrl: "https://denik.teams.ghosty.studio/preview/96",
};

describe("check «Ghosty · Preview»", () => {
  it("preview lista en la cabeza y smoke limpio → success", () => {
    const c = previewCheckFrom(base);
    expect(c).toMatchObject({ status: "completed", conclusion: "success", title: "Preview lista" });
    expect(c.summary).toContain("https://denik.teams.ghosty.studio/preview/96");
    expect(c.detailsUrl).toBe("https://denik.teams.ghosty.studio/preview/96");
  });

  it("nunca publica la llave de la preview (?k=), ni en el resumen ni en «Detalles»", () => {
    const k = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const casos = [
      { ...base, preview: { ...base.preview, url: `https://pr-7.preview.test/?k=${k}` } },
      { ...base, smokeFail: `GET https://pr-7.preview.test/?k=${k} → 500` },
      { ...base, preview: { state: "failed" as const, sha: null, error: `build en https://pr-7.preview.test/?k=${k}` } },
      { ...base, preview: { state: "pending" as const, sha: null } },
    ];
    for (const c of casos) {
      const r = previewCheckFrom(c);
      expect(r.summary).not.toContain(k);
      expect(r.title).not.toContain(k);
      expect(r.summary).not.toMatch(/[?&]k=/);
      expect(r.detailsUrl ?? "").not.toMatch(/[?&]k=/);
    }
  });

  it("el resumen trae la tabla de pasos (caja, preview, smoke)", () => {
    const ok = previewCheckFrom(base).summary;
    expect(ok).toContain("| Caja de trabajo | ✅ |");
    expect(ok).toContain("| Preview del commit | ✅ |");
    expect(ok).toContain("| Smoke (POST con el Origin real) | ✅ |");
    const building = previewCheckFrom({ ...base, preview: { state: "pending", sha: null } }).summary;
    expect(building).toContain("| Preview del commit | ⏳ |");
    expect(building).toContain("| Smoke (POST con el Origin real) | ▫️ |");
    expect(previewCheckFrom({ ...base, smokeFail: "x" }).summary).toContain("| Smoke (POST con el Origin real) | ❌ |");
  });

  it("construyéndose, sin preview aún o lista de un commit viejo → in_progress", () => {
    expect(previewCheckFrom({ ...base, preview: { state: "pending", sha: null } }).status).toBe("in_progress");
    expect(previewCheckFrom({ ...base, preview: { state: "none", sha: null } }).status).toBe("in_progress");
    const old = previewCheckFrom({ ...base, preview: { state: "ready", sha: "viejo" } });
    expect(old).toMatchObject({ status: "in_progress", conclusion: null });
  });

  it("el #96: faltan variables → failure con la liga para guardarlas", () => {
    const c = previewCheckFrom({ ...base, preview: { state: "needs_env", sha: null } });
    expect(c).toMatchObject({ status: "completed", conclusion: "failure", title: "La preview espera las variables del repo" });
    expect(c.summary).toContain("/factory?repo=denik%2Fagenda");
  });

  it("preview que no arrancó → failure con el motivo", () => {
    const c = previewCheckFrom({ ...base, preview: { state: "failed", sha: null, error: "npm ci falló" } });
    expect(c).toMatchObject({ conclusion: "failure", title: "La preview falló" });
    expect(c.summary).toContain("npm ci falló");
  });

  it("el smoke rechazó el POST en esta cabeza → failure aunque la preview esté lista", () => {
    const c = previewCheckFrom({ ...base, smokeFail: "POST / → 400 (CSRF)" });
    expect(c).toMatchObject({ conclusion: "failure", title: "La preview rechaza envíos" });
    expect(c.summary).toContain("400 (CSRF)");
  });

  it("no exigida → neutral (GitHub la cuenta como pasada); repo apagado lo dice", () => {
    expect(previewCheckFrom({ ...base, required: false, preview: { state: "none", sha: null } })).toMatchObject({
      conclusion: "neutral",
      title: "Este pedido no exige preview",
    });
    expect(previewCheckFrom({ ...base, required: false, repoOff: true, preview: { state: "off", sha: null } }).title).toBe("Preview apagada en este repo");
  });

  it("«Mezclar sin preview» → neutral con quién la omitió, gane lo que gane", () => {
    const c = previewCheckFrom({ ...base, preview: { state: "needs_env", sha: null }, skippedBy: "Brenda" });
    expect(c).toMatchObject({ status: "completed", conclusion: "neutral", title: "Preview omitida por Brenda" });
  });

  it("PR suelto → neutral", () => {
    expect(previewCheckFrom(null)).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  it("no cuenta como CI: un «Ghosty · Preview» construyéndose no deja el CI en pendiente", () => {
    const s = aggregateChecks(
      { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }, { name: "Ghosty · Preview", status: "in_progress" }] },
      null,
    );
    expect(s).toMatchObject({ state: "success", total: 1 });
  });
});

