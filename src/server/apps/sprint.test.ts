import { describe, it, expect } from "vitest";
import { findCycle, itemStatusOf, nextReady, validateSprintItems } from "./sprint.server";

const t = (key: string, depends_on: string[] = [], size = "S") => ({ key, title: `T ${key}`, size, depends_on, criteria: "- pasa `npm test`" });

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
