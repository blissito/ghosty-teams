import { describe, expect, it } from "vitest";
import { devRunFence, isClosedPhase, phaseLine, routesToWriter, writerMessages } from "./dev-threads.server";

describe("hilo del room = vista del pendiente de gs", () => {
  it("sin menciones o sólo @ghosty va al escritor; otro agente no", () => {
    expect(routesToWriter([])).toBe(true);
    expect(routesToWriter(["ghosty"])).toBe(true);
    expect(routesToWriter(["plan"])).toBe(false);
    expect(routesToWriter(["ghosty", "check"])).toBe(false);
  });
  it("sólo publica una línea cuando la fase cambia y pide algo o cierra", () => {
    expect(phaseLine("working", "needs_person")).toContain("Te toca decidir");
    expect(phaseLine("needs_person", "needs_person")).toBeNull();
    expect(phaseLine("working", "waiting_ci")).toBeNull();
    expect(phaseLine("reviewing", "merged")).toContain("Mezclado");
  });
  it("del escritor sólo pasan sus mensajes con texto", () => {
    const out = writerMessages([
      { seq: 1, role: "user", text: "Empieza el pendiente #3" },
      { seq: 2, role: "assistant", text: "  Ya abrí el PR.  " },
      { seq: 3, role: "assistant", text: "" },
    ]);
    expect(out).toEqual([{ seq: 2, text: "Ya abrí el PR." }]);
  });
  it("fases cerradas y fence", () => {
    expect(isClosedPhase("merged")).toBe(true);
    expect(isClosedPhase("working")).toBe(false);
    expect(devRunFence("abc")).toBe('```gt-devrun\n{"runId":"abc"}\n```');
  });
});

import { planCriteria } from "./dev-threads.server";
describe("criterios del plan", () => {
  it("toma la lista bajo «Criterios de aceptación» y nada más", () => {
    const md = "# Botón\n## Historia\n- no esto\n## Criterios de aceptación\n- [ ] el botón guarda\n2. muestra aviso\n## Riesgos\n- tampoco";
    expect(planCriteria(md)).toEqual(["el botón guarda", "muestra aviso"]);
  });
});

import { devRunView } from "./dev-threads";
describe("tarjeta del pendiente", () => {
  it("te necesita = te toca decidir; listo = se puede mezclar", () => {
    expect(devRunView("a", { phase: "needs_person", estado: "Te necesita", title: "X" })).toMatchObject({ needsPerson: true, canMerge: false, label: "Te necesita", live: true });
    expect(devRunView("a", { phase: "reviewing", ready: true })).toMatchObject({ canMerge: true });
    expect(devRunView("a", { phase: "merged", ready: true })).toMatchObject({ canMerge: false, live: false });
  });
});
