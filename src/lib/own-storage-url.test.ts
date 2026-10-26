import { describe, expect, it } from "vitest";
import { ownStoragePath } from "./own-storage-url";

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
