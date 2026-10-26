import { describe, expect, it } from "vitest";
import { sniffMime } from "./published-attach.server";
import { isContentSegment } from "../agents.server";

const b = (hex: string) => Buffer.from(hex.padEnd(32, "0"), "hex");

describe("sniffMime", () => {
  it("reconoce por firma", () => {
    expect(sniffMime(b("ffd8ffe0"))?.mime).toBe("image/jpeg");
    expect(sniffMime(b("89504e470d0a1a0a"))?.mime).toBe("image/png");
    expect(sniffMime(b("524946460000000057454250"))?.mime).toBe("image/webp");
    expect(sniffMime(b("255044462d"))?.mime).toBe("application/pdf");
    expect(sniffMime(b("0000001866747970"))?.mime).toBe("video/mp4");
    expect(sniffMime(b("00112233"))).toBeNull();
  });
});

describe("isContentSegment", () => {
  it("imagen o bloque = contenido; texto = paso", () => {
    expect(isContentSegment("![Banner](https://x/y.jpg)\n\nexplicación")).toBe(true);
    expect(isContentSegment("```js\nx\n```")).toBe(true);
    expect(isContentSegment("Voy a revisar el logo [aquí](https://x)")).toBe(false);
  });
});
