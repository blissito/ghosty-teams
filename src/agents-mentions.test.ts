// `@ghostyinformación en materia…` — la persona escribió el handle y siguió sin espacio — no
// despertaba a nadie (descti, 2026-09-11): el regex exigía `\b` después del handle. Estos
// casos fijan la regla nueva: exacto primero (agente o persona), y si no, el handle de
// agente más largo que sea prefijo del token.
import { describe, expect, it } from "vitest";

import { detectMentions } from "./agents.server";

const AGENTES = ["ghosty", "goose", "ana", "ghosty-lite"];

describe("detectMentions", () => {
  it("handle pegado al texto que sigue", () => {
    expect(detectMentions("@ghostyinformación en materia de control interno", AGENTES)).toEqual(["ghosty"]);
    expect(detectMentions("@goose  \n\nNecesito que revises", AGENTES)).toEqual(["goose"]);
  });
  it("exacto y case-insensitive, en orden de aparición, sin duplicados", () => {
    expect(detectMentions("oye @Goose y @ghosty, y otra vez @goose", AGENTES)).toEqual(["goose", "ghosty"]);
  });
  it("gana el handle conocido más largo", () => {
    expect(detectMentions("@ghosty-lite hola", AGENTES)).toEqual(["ghosty-lite"]);
    expect(detectMentions("@ghosty-lit hola", AGENTES)).toEqual(["ghosty"]);
  });
  it("un handle exacto de PERSONA no despierta al agente prefijo", () => {
    expect(detectMentions("@anabel revisa esto", AGENTES, ["anabel"])).toEqual([]);
    expect(detectMentions("@anabel revisa esto", AGENTES)).toEqual(["ana"]);
  });
  it("un correo no es una mención", () => {
    expect(detectMentions("escríbele a foo@ghosty.com", AGENTES)).toEqual([]);
    expect(detectMentions("foo@goose", AGENTES)).toEqual([]);
  });
  it("sin @ conocido, nada", () => {
    expect(detectMentions("@nadie hola", AGENTES)).toEqual([]);
    expect(detectMentions("hola sin menciones", AGENTES)).toEqual([]);
  });
});
