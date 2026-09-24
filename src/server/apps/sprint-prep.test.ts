import { describe, it, expect, vi } from "vitest";

let level = 1;
vi.mock("./readiness.server", () => ({
  repoReadiness: async () => ({ level, checks: [], facts: {} }),
  preparationPlan: () => ({ planMd: "# Preparar", fixes: level < 2 ? ["agents_md"] : [] }),
}));

const { withPrepFirst } = await import("./sprint.server");
const items = [
  { key: "A", title: "a", size: "S" as const, dependsOn: [], bodyMd: "x" },
  { key: "B", title: "b", size: "M" as const, dependsOn: ["A"], bodyMd: "x" },
];

describe("sprint en un repo que no está listo para agentes", () => {
  it("nivel < 2: antepone «Preparar repo» y los tickets sin dependencias esperan su merge", async () => {
    level = 1;
    const out = await withPrepFirst("u", "acme/app", items);
    expect(out[0].key).toBe("prep");
    expect(out.find((i) => i.key === "A")!.dependsOn).toEqual(["prep"]);
    expect(out.find((i) => i.key === "B")!.dependsOn).toEqual(["A"]);
  });

  it("nivel ≥ 2: el sprint queda igual", async () => {
    level = 2;
    expect(await withPrepFirst("u", "acme/app", items)).toEqual(items);
  });
});
