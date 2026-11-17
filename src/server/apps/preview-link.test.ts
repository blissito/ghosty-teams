import { describe, expect, it } from "vitest";
import { hasPreviewKey, previewOpenPath, scrubPreviewKeys, stripPreviewKey, withPreviewKey } from "./preview-link";

describe("preview-link", () => {
  const keyed = "https://sb-abc-3000.preview.ghosty.page/dash?k=0123456789abcdef0123456789abcdef";
  it("quita la llave y conserva el resto", () => {
    expect(stripPreviewKey(keyed)).toBe("https://sb-abc-3000.preview.ghosty.page/dash");
    expect(stripPreviewKey("https://x.test/a?z=1&k=abcdef12&y=2")).toBe("https://x.test/a?z=1&y=2");
    expect(stripPreviewKey(null)).toBeNull();
  });
  it("detecta la llave", () => {
    expect(hasPreviewKey(keyed)).toBe(true);
    expect(hasPreviewKey("https://x.test/?key=1")).toBe(false);
  });
  it("limpia ligas en texto libre (markdown, resúmenes)", () => {
    const t = `Lista: [Abrir](${keyed}) y ${keyed}. Otra https://vercel.app/?k=zzz`;
    const out = scrubPreviewKeys(t);
    expect(out).not.toContain("k=0123456789abcdef");
    expect(out).toContain("[Abrir](https://sb-abc-3000.preview.ghosty.page/dash)");
    expect(out).toContain("https://vercel.app/?k=zzz"); // llave corta: no es la nuestra
  });
  it("arma y devuelve la llave", () => {
    expect(withPreviewKey("https://sb-a-3000.x.page/", "kk")).toBe("https://sb-a-3000.x.page/?k=kk");
    expect(previewOpenPath(7)).toBe("/preview/7");
    expect(previewOpenPath(7, "https://acme.teams.ghosty.studio/")).toBe("https://acme.teams.ghosty.studio/preview/7");
  });
});
