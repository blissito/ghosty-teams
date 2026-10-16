import { describe, expect, it } from "vitest";
import { droppedRoleMentions, pickRespondents, relayTargets } from "./agent-handoff.server";
import { resolvePersonaMentions } from "./apps/factory-roles";

describe("pickRespondents", () => {
  it("un pedido de coordinación arranca sólo al primero (el caso real de #divi, con su errata)", () => {
    const body = "@ghosty cordina con @fable los trabajos para generar un documento de Modelo de Operación";
    expect(pickRespondents(body, ["ghosty", "fable"])).toEqual(["ghosty"]);
    expect(pickRespondents("@fable coordínate con @ghosty para el oficio", ["fable", "ghosty"])).toEqual(["fable"]);
    expect(pickRespondents("@ghosty trabaja con @astra en esto", ["ghosty", "astra"])).toEqual(["ghosty"]);
    expect(pickRespondents("@ghosty coordinate with @fable on the report", ["ghosty", "fable"])).toEqual(["ghosty"]);
    expect(pickRespondents("@ghosty work with @fable and ask @astra for the numbers", ["ghosty", "fable", "astra"])).toEqual(["ghosty"]);
  });
  it("sin verbo de coordinación siguen contestando todos", () => {
    expect(pickRespondents("@ghosty @fable ¿qué opinan de este oficio?", ["ghosty", "fable"])).toEqual(["ghosty", "fable"]);
    expect(pickRespondents("@ghosty coordina la reunión del lunes", ["ghosty"])).toEqual(["ghosty"]);
  });
});

describe("relayTargets", () => {
  it("entre roles de la fábrica no hay relevo por mención (la estafeta es de la plataforma)", () => {
    expect(relayTargets(["build", "check"], "plan")).toEqual([]);
  });
  it("un rol sí despierta a un agente que no es de la fábrica", () => {
    expect(relayTargets(["build", "ventas"], "plan")).toEqual(["ventas"]);
  });
  it("cualquier otro agente despierta a quien menciona, roles incluidos", () => {
    expect(relayTargets(["build", "aria"], "ghosty")).toEqual(["build", "aria"]);
  });
  it("nadie se despierta a sí mismo", () => {
    expect(relayTargets(["aria"], "aria")).toEqual([]);
  });
});

describe("droppedRoleMentions", () => {
  it("la @ de un rol a otro se avisa; la de una persona o de un agente común no", () => {
    expect(droppedRoleMentions(["plan", "fixtergeek"], "check")).toEqual(["plan"]);
    expect(droppedRoleMentions(["check"], "check")).toEqual([]);
    expect(droppedRoleMentions(["plan"], "ghosty")).toEqual([]);
  });
});

describe("resolvePersonaMentions (Arqui = @plan + @check)", () => {
  const handles = ["plan", "build", "check", "ghosty"];
  // El caso real de #denik (16-oct): mensaje nuevo con @arqui que además nombra a @check.
  it("un mensaje nuevo «@arqui … @check …» despierta sólo a @plan", () => {
    expect(resolvePersonaMentions(["plan", "check"], { arquiOnly: false, runStatus: null, handles })).toEqual(["plan"]);
    expect(resolvePersonaMentions(["plan"], { arquiOnly: true, runStatus: null, handles })).toEqual(["plan"]);
  });
  it("en el hilo de un pedido en revisión, @arqui va a @check (uno solo)", () => {
    expect(resolvePersonaMentions(["plan"], { arquiOnly: true, runStatus: "checking", handles })).toEqual(["check"]);
    expect(resolvePersonaMentions(["plan", "check"], { arquiOnly: false, runStatus: "checking", handles })).toEqual(["check"]);
    expect(resolvePersonaMentions(["plan"], { arquiOnly: true, runStatus: "pr_review", handles })).toEqual(["check"]);
  });
  it("planeando o construyendo, Arqui es @plan", () => {
    expect(resolvePersonaMentions(["plan", "check"], { arquiOnly: false, runStatus: "plan_review", handles })).toEqual(["plan"]);
    expect(resolvePersonaMentions(["check"], { arquiOnly: true, runStatus: "building", handles })).toEqual(["plan"]);
  });
  it("un @plan o @check escrito a solas se respeta, y los demás agentes no se tocan", () => {
    expect(resolvePersonaMentions(["check"], { arquiOnly: false, runStatus: null, handles })).toEqual(["check"]);
    expect(resolvePersonaMentions(["plan"], { arquiOnly: false, runStatus: "checking", handles })).toEqual(["plan"]);
    expect(resolvePersonaMentions(["ghosty", "check", "build", "plan"], { arquiOnly: false, runStatus: null, handles })).toEqual(["ghosty", "plan", "build"]);
    expect(resolvePersonaMentions(["ghosty"], { arquiOnly: false, runStatus: null, handles })).toEqual(["ghosty"]);
  });
  it("sin @check en el espacio, la revisión sigue con @plan", () => {
    expect(resolvePersonaMentions(["plan"], { arquiOnly: true, runStatus: "checking", handles: ["plan", "build"] })).toEqual(["plan"]);
  });
});
