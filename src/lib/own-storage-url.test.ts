import { describe, expect, it } from "vitest";
import { ownStoragePath, rewriteOwnPresigned } from "./own-storage-url";

describe("ownStoragePath", () => {
  it("convierte una presignada propia en la ruta que re-firma", () => {
    const url =
      "https://t3.storage.dev/ghosty-teams/t3/banner-hoy-toca-tanda-222698.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&X-Amz-Signature=abc";
    expect(ownStoragePath(url)).toBe("/api/attachment/t3%2Fbanner-hoy-toca-tanda-222698.jpg");
  });
  it("deja en paz lo ajeno y lo ya permanente", () => {
    expect(ownStoragePath("https://example.com/a.png")).toBeNull();
    expect(ownStoragePath("/api/attachment/t3%2Fx.png")).toBeNull();
    expect(ownStoragePath("https://t3.storage.dev/otro-bucket/t3/x.png?X-Amz-Signature=1")).toBeNull();
  });
});

describe("rewriteOwnPresigned", () => {
  const pre = "https://t3.storage.dev/ghosty-teams/t3/a.jpg?X-Amz-Expires=604800&X-Amz-Signature=x";
  it("reescribe imágenes y ligas propias, deja lo ajeno", () => {
    const md = `![banner](${pre})\n\n[bájalo](${pre}) y ![otra](https://example.com/b.png)`;
    expect(rewriteOwnPresigned(md)).toBe(
      "![banner](/api/attachment/t3%2Fa.jpg)\n\n[bájalo](/api/attachment/t3%2Fa.jpg) y ![otra](https://example.com/b.png)"
    );
  });
  it("sin presignadas no toca nada", () => {
    expect(rewriteOwnPresigned("hola ![x](/api/attachment/y)")).toBe("hola ![x](/api/attachment/y)");
  });
});
