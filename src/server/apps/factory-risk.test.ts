import { describe, it, expect } from "vitest";
import { classifyPrRisk, mergeCheckRisk } from "./factory-risk";
import { shotUrl } from "./factory-shots.server";

const f = (filename: string, additions = 5, deletions = 0) => ({ filename, additions, deletions });

describe("riesgo de un PR", () => {
  it("un cambio chico de UI es bajo", () => {
    expect(classifyPrRisk([f("src/components/Button.tsx"), f("src/routes/ventas.tsx")])).toEqual({ level: "low", reasons: [] });
  });

  it("marca cada ruta sensible con su razón", () => {
    expect(classifyPrRisk([f(".github/workflows/ci.yml")]).reasons).toEqual(["github"]);
    expect(classifyPrRisk([f("prisma/schema.prisma")]).reasons).toContain("migration");
    expect(classifyPrRisk([f("db/migrations/002_add.sql")]).reasons).toContain("migration");
    expect(classifyPrRisk([f("src/server/auth.server.ts")]).reasons).toEqual(["auth"]);
    expect(classifyPrRisk([f("app/lib/partner-hmac.server.ts")]).reasons).toEqual(["auth"]);
    expect(classifyPrRisk([f("package.json"), f("pnpm-lock.yaml")]).reasons).toEqual(["deps"]);
    expect(classifyPrRisk([f("src/routes/api.v2.agents.ts")]).reasons).toEqual(["api"]);
  });

  it("no confunde palabras que sólo contienen la raíz", () => {
    expect(classifyPrRisk([f("src/components/Author.tsx"), f("src/lib/tokenizer-ui.ts")]).level).toBe("low");
  });

  it("un PR grande es alto aunque no toque nada sensible", () => {
    expect(classifyPrRisk([f("src/a.ts", 300, 150)])).toEqual({ level: "high", reasons: ["size"] });
  });

  it("@check sube el nivel pero no lo baja, y «Lee primero» se recorta", () => {
    const low = { level: "low" as const, reasons: [] };
    expect(mergeCheckRisk(low, { risk: "high" }).level).toBe("high");
    expect(mergeCheckRisk({ level: "high", reasons: ["auth"] }, { risk: "low" }).level).toBe("high");
    const many = Array.from({ length: 8 }, (_, i) => ({ file: `a${i}.ts`, lines: "1-2" }));
    expect(mergeCheckRisk(low, { readFirst: [...many, { nope: 1 }] }).readFirst).toHaveLength(5);
    expect(mergeCheckRisk(low, { readFirst: "x" }).readFirst).toEqual([]);
  });
});

describe("URL de la captura de la preview", () => {
  it("conserva la llave y cambia sólo la ruta", () => {
    const p = "https://sb-x-3000.sandboxes.easybits.cloud/?k=abc";
    expect(shotUrl(p)).toBe(p);
    expect(shotUrl(p, "/ventas")).toBe("https://sb-x-3000.sandboxes.easybits.cloud/ventas?k=abc");
    expect(shotUrl(p, "/agenda?dia=2")).toBe("https://sb-x-3000.sandboxes.easybits.cloud/agenda?k=abc&dia=2");
    expect(shotUrl(p, "https://evil.com/")).toBe(p);
    expect(shotUrl(p, "//evil.com/x")).toBe(p);
  });
});

describe("clipSentence", async () => {
  const { clipSentence } = await import("./factory-risk");
  it("no deja palabras a medias", () => {
    const why = "El EPP sólo se filtra en list y transfer-out; los demás --json imprimen la respuesta del SDK tal cual. Hoy ninguna trae el código, pero si la API agrega uno se filtraría";
    const out = clipSentence(why, 140);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith(".") || out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/agre$/);
  });
  it("deja intacto lo que cabe", () => {
    expect(clipSentence("  corto  ", 50)).toBe("corto");
  });
});
