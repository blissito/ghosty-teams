import { describe, it, expect } from "vitest";
import { parseTeamFile, parseMessageOverrides, resolveModel, teamFileTemplate } from "./factory-team";

describe("parseTeamFile", () => {
  it("lee las dos formas del frontmatter y el cuerpo", () => {
    const f = parseTeamFile(
      "---\nplan:  { agent: Constructor, model: claude-opus-5 }\nbuild:\n  model: \"claude-sonnet-5\"\ncheck: { agent: OtroGhosty }\nfoo: { agent: x }\n---\nCorre `npm test`.\n",
    );
    expect(f.roles.plan).toEqual({ agent: "Constructor", model: "claude-opus-5" });
    expect(f.roles.build).toEqual({ model: "claude-sonnet-5" });
    expect(f.roles.check).toEqual({ agent: "OtroGhosty" });
    expect(f.notes).toBe("Corre `npm test`.");
  });

  it("sin frontmatter todo es nota", () => {
    expect(parseTeamFile("sólo convenciones")).toEqual({ roles: {}, notes: "sólo convenciones" });
  });

  it("la plantilla se vuelve a leer igual", () => {
    const f = parseTeamFile(teamFileTemplate({ plan: { name: "Constructor", model: "claude-sonnet-5" } }));
    expect(f.roles.plan).toEqual({ agent: "Constructor", model: "claude-sonnet-5" });
    expect(f.roles.build).toBeUndefined();
  });
});

describe("parseMessageOverrides", () => {
  const repos = ["blissito/agenda", "blissito/denik"];
  it("modelo por rol y repo del room", () => {
    expect(parseMessageOverrides("@build con opus en agenda arregla el login", repos)).toEqual({ models: { build: "opus" }, repo: "blissito/agenda" });
    expect(parseMessageOverrides("@plan en blissito/denik con sol, porfa", repos)).toEqual({ models: { plan: "sol" }, repo: "blissito/denik" });
  });
  it("ignora palabras que no son modelo ni repo del room", () => {
    expect(parseMessageOverrides("@build con cuidado en producción", repos)).toEqual({});
    expect(parseMessageOverrides("hola @check", repos)).toEqual({});
  });
});

describe("resolveModel", () => {
  it("alias e id del mismo motor; null si es de otro", () => {
    expect(resolveModel("claude", "opus")).toBe("claude-opus-5");
    expect(resolveModel("claude", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveModel("codex", "opus")).toBeNull();
    expect(resolveModel("deepseek", "pro")).toBe("deepseek-v4-pro");
  });
});
