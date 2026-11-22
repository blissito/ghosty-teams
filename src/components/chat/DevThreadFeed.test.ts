import { describe, expect, it } from "vitest";
import { mergeFeed } from "./DevThreadFeed";

describe("hilo del pendiente", () => {
  it("intercala Teams y gs por hora; lo de gs sin hora va al final", () => {
    const real = [{ id: 1, created_at: 100 }, { id: 2, created_at: 300 }] as never[];
    const dev = [
      { seq: 1, role: "writer" as const, text: "a", at: new Date(200_000).toISOString(), by: null },
      { seq: 2, role: "writer" as const, text: "b", at: null, by: null },
    ];
    const out = mergeFeed(real, dev).map((i) => (i.kind === "real" ? `r${i.m.id}` : `d${i.d.seq}`));
    expect(out).toEqual(["r1", "d1", "r2", "d2"]);
  });
});
