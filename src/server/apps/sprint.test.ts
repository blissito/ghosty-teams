import { describe, it, expect } from "vitest";
import { findCycle, itemStatusOf, nextReady, ticketFiles, ticketLine, validateSprintItems } from "./sprint.server";

const t = (key: string, depends_on: string[] = [], size = "S") => ({ key, title: `Ticket ${key} del CLI`, size, depends_on, criteria: "- pasa `npm test` y el lint" });

describe("sprint: validación de lo que manda @plan", () => {
  it("3 a 8 tickets, keys únicas, tamaños S/M/L, criterios", () => {
    expect(validateSprintItems([t("A"), t("B")])).toMatch(/de 3 a 8/);
    expect(validateSprintItems([t("A"), t("A"), t("B")])).toMatch(/repetida/);
    expect(validateSprintItems([t("A"), t("B"), t("C", [], "XL")])).toMatch(/S, M o L/);
    expect(validateSprintItems([t("A"), t("B"), { ...t("C"), criteria: "" }])).toMatch(/criterios/);
    const ok = validateSprintItems([t("A"), t("B", ["A"]), t("C")]);
    expect(Array.isArray(ok) && ok[1].dependsOn).toEqual(["A"]);
    expect(Array.isArray(ok) && ok[0].bodyMd).toContain("## Criterios de aceptación");
  });

  it("un sprint de prueba (títulos o criterios de relleno) se rechaza sin crear nada", () => {
    expect(validateSprintItems([{ ...t("A"), title: "t" }, t("B"), t("C")])).toMatch(/parece de prueba/);
    expect(validateSprintItems([t("A"), { ...t("B"), criteria: "g" }, t("C")])).toMatch(/parece de prueba/);
  });

  it("un ticket que no termina en PR (decisión de la persona) se rechaza", () => {
    expect(validateSprintItems([t("A"), t("B"), { ...t("C"), title: "Decisión: dominio y hosting" }])).toMatch(/no termina en un PR/);
    expect(validateSprintItems([t("A"), t("B"), { ...t("C"), criteria: "No lleva PR: se anota la decisión" }])).toMatch(/no termina en un PR/);
  });

  it("dependencias que no existen o en círculo se rechazan", () => {
    expect(validateSprintItems([t("A", ["Z"]), t("B"), t("C")])).toMatch(/«Z», que no existe/);
    expect(validateSprintItems([t("A", ["C"]), t("B", ["A"]), t("C", ["B"])])).toMatch(/en círculo/);
    expect(findCycle([{ key: "A", dependsOn: [] }, { key: "B", dependsOn: ["A"] }])).toBeNull();
  });
});

describe("sprint: qué arranca y cuándo", () => {
  const item = (key: string, status: any, dependsOn: string[] = [], included = true) => ({ key, status, dependsOn, included });

  it("A → B y C suelto: arranca A; C espera mientras A trabaja; luego C, y B tras el merge de A", () => {
    expect(nextReady([item("A", "pending"), item("B", "pending", ["A"]), item("C", "pending")])?.key).toBe("A");
    expect(nextReady([item("A", "active"), item("B", "pending", ["A"]), item("C", "pending")])).toBeNull();
    // A en PR (esperando a una persona): C no depende de A, así que arranca.
    expect(nextReady([item("A", "pr"), item("B", "pending", ["A"]), item("C", "pending")])?.key).toBe("C");
    expect(nextReady([item("A", "merged"), item("B", "pending", ["A"]), item("C", "merged")])?.key).toBe("B");
  });

  it("un ticket que toca lo mismo que un PR abierto espera; toma el que no se cruza", () => {
    const md = (...f: string[]) => `# t\n\n## Criterios de aceptación\nx\n\n## Archivos principales\n${f.map((x) => `- \`${x}\``).join("\n")}\n`;
    const withFiles = (key: string, status: any, files: string[]) => ({ ...item(key, status), bodyMd: md(...files) });
    expect(ticketFiles(md("package.json", "./src/app/"))).toEqual(["package.json", "src/app/"]);
    // D (pr) toca package.json; B también → espera; C no se cruza → arranca.
    const its = [withFiles("D", "pr", ["package.json", ".github/workflows/ci.yml"]), withFiles("B", "pending", ["package.json"]), withFiles("C", "pending", ["src/app/sitemap.ts"])];
    expect(nextReady(its)?.key).toBe("C");
    // Carpeta contra archivo dentro de ella también cuenta.
    expect(nextReady([withFiles("A", "pr", ["src/app/"]), withFiles("B", "pending", ["src/app/[locale]/layout.tsx"])])).toBeNull();
    // Sin archivos anotados no se bloquea (como antes).
    expect(nextReady([withFiles("A", "pr", ["package.json"]), item("B", "pending")])?.key).toBe("B");
  });

  it("un ticket fallido detiene el sprint hasta decidir; uno quitado cuenta como resuelto", () => {
    expect(nextReady([item("A", "failed"), item("B", "pending")])).toBeNull();
    expect(nextReady([item("A", "skipped"), item("B", "pending", ["A"])])?.key).toBe("B");
    expect(nextReady([item("A", "pending", [], false), item("B", "pending", ["A"])])?.key).toBe("B");
  });

  it("el estado del ticket sale de su pedido", () => {
    expect(itemStatusOf("building", "active")).toBe("active");
    expect(itemStatusOf("pr_review", "active")).toBe("pr");
    expect(itemStatusOf("done", "pr")).toBe("merged");
    expect(itemStatusOf("cancelled", "active")).toBe("failed");
    expect(itemStatusOf(null, "skipped")).toBe("skipped");
  });
});

describe("ticketLine (avisos del hilo del sprint)", () => {
  const it0 = { idx: 2, title: "SDK" };
  it("PR listo, mezclado y cancelado llevan sus ligas", () => {
    expect(ticketLine("pr", it0, 3, "https://github.com/o/r/pull/9", "/c/dev?thread=5")).toBe("🔎 **Listo para revisar, ticket 2 de 3:** SDK · [PR](https://github.com/o/r/pull/9) · [ver pedido](/c/dev?thread=5)");
    expect(ticketLine("merged", it0, 3, null, "")).toBe("✅ **Merge hecho, ticket 2 de 3:** SDK");
    expect(ticketLine("failed", it0, 3, null, "")).toContain("Reintentar");
  });
  it("activo o pendiente no se anuncian (el arranque lo avisa startItem)", () => {
    expect(ticketLine("active", it0, 3, null, "")).toBeNull();
    expect(ticketLine("pending", it0, 3, null, "")).toBeNull();
  });
});
