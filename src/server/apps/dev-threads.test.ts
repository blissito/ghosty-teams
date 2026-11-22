import { describe, expect, it } from "vitest";
import { devRunFence, routesToWriter, writerMessages } from "./dev-threads.server";

describe("hilo del room = vista del pendiente de gs", () => {
  it("sólo @ghosty va al escritor; sin @ o con otro agente no", () => {
    expect(routesToWriter([])).toBe(false);
    expect(routesToWriter(["ghosty"])).toBe(true);
    expect(routesToWriter(["plan"])).toBe(false);
    expect(routesToWriter(["ghosty", "check"])).toBe(false);
  });
  it("del escritor sólo pasan sus mensajes con texto", () => {
    const out = writerMessages([
      { seq: 1, role: "user", text: "Empieza el pendiente #3" },
      { seq: 2, role: "assistant", text: "  Ya abrí el PR.  " },
      { seq: 3, role: "assistant", text: "" },
    ]);
    expect(out).toEqual([{ seq: 2, text: "Ya abrí el PR." }]);
  });
  it("fence", () => {
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

import { adoptedRootText, roomForRepo } from "./dev-threads.server";
describe("adoptar pendientes que nacieron fuera del room", () => {
  it("encuentra el room del repo sin importar mayúsculas y arma la cabeza del hilo", () => {
    const rooms = [{ channel_id: 7, repo: "blissito/MailMask", connected_by: "u1" }];
    expect(roomForRepo(rooms, "blissito/mailmask")?.channel_id).toBe(7);
    expect(roomForRepo(rooms, "otro/repo")).toBeNull();
    expect(adoptedRootText({ issue: 138, title: "Blog", repo: "blissito/mailmask" })).toBe("🛠️ **Pendiente #138** · Blog — blissito/mailmask");
  });
});

import { chatMessages } from "./dev-threads";
describe("chat de la tarjeta", () => {
  it("usa el kind de gs y deduce del rol si no viene; la etapa numérica no es etiqueta", () => {
    expect(chatMessages([{ seq: 1, kind: "platform", text: "Turno programado" }, { seq: 2, role: "assistant", text: "¿A o B?" }, { seq: 3, role: "user", text: "A", from: "github", by: "@bliss" }, { seq: 4, kind: "writer", text: " " }, { seq: 5, kind: "person", text: "dup", from: "room" }])).toEqual([
      { seq: 1, role: "platform", text: "Turno programado", at: null, by: null },
      { seq: 2, role: "writer", text: "¿A o B?", at: null, by: null },
      { seq: 3, role: "person", text: "A", at: null, by: "@bliss" },
    ]);
    expect(devRunView("a", { phase: "needs_person", stage: 3, estado: "Te necesita" }).label).toBe("Te necesita");
  });
});

import { lastAskOptions } from "./dev-threads";
describe("pregunta del escritor", () => {
  it("la pregunta sale de note y las opciones del último asked_person", () => {
    const d = { phase: "needs_person", note: "¿Publico ya?", events: [{ kind: "asked_person", data: { options: ["Viejo"] } }, { kind: "asked_person", data: { question: "x", options: ["Sí", { label: "No" }] } }] };
    expect(devRunView("a", d)).toMatchObject({ question: "¿Publico ya?", options: ["Sí", "No"] });
    expect(lastAskOptions(null)).toEqual([]);
    expect(devRunView("a", { phase: "working", note: "vieja" }).question).toBeNull();
  });
});
