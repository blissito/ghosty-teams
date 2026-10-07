import { describe, it, expect } from "vitest";
import { knowledgeLine, parseTeamFile, parseMessageOverrides, resolveModel, setupLine, teamFileTemplate } from "./factory-team";

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
    expect(parseTeamFile("sólo convenciones")).toEqual({ roles: {}, notes: "sólo convenciones", roleNotes: {} });
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
    expect(resolveModel("claude", "opus-5.5")).toBe("claude-opus-5-5");
    expect(resolveModel("claude", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(resolveModel("claude", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveModel("codex", "opus")).toBeNull();
    expect(resolveModel("deepseek", "pro")).toBe("deepseek-v4-pro");
  });
});

describe("base de conocimiento del repo", () => {
  it("lista las fichas con su carpeta, o dice cómo empezar", () => {
    expect(knowledgeLine("a/b", ["pagos.md", "glosario.md"])).toContain("docs/agents/pagos.md, docs/agents/glosario.md");
    expect(knowledgeLine("a/b", [])).toContain("todavía no hay fichas");
    expect(knowledgeLine("a/b", Array.from({ length: 45 }, (_, i) => `f${i}.md`))).toContain("y 5 más");
  });
});

describe("reglas por rol en .ghosty/factory.md", () => {
  it("lo de `## @check` va sólo a @check y lo demás a los tres", () => {
    const f = parseTeamFile(
      "---\nbuild: { model: sonnet }\n---\nUsa pnpm.\n\n## @check\nUn cambio a migraciones sin prueba es hallazgo.\n\n## Estilo\nTabs.\n",
    );
    expect(f.roleNotes.check).toBe("Un cambio a migraciones sin prueba es hallazgo.");
    expect(f.roleNotes.build).toBeUndefined();
    expect(f.notes).toContain("Usa pnpm.");
    expect(f.notes).toContain("## Estilo\nTabs.");
    expect(f.notes).not.toContain("migraciones");
  });
  it("sin frontmatter también separa las secciones", () => {
    const f = parseTeamFile("## plan\nPlanes de 5 pasos máx.\n");
    expect(f.roleNotes.plan).toBe("Planes de 5 pasos máx.");
    expect(f.notes).toBe("");
  });
});

describe("setup: en .ghosty/factory.md", () => {
  const file = `---
build: { agent: Constructor }
setup:
  services: [postgres, redis, mongo]   # mongo no viene en la caja: se ignora
  db: fruteria
  script: ./.ghosty/setup.sh
  env:
    JWT_SECRET: test-actions-jwt-secret
    ADMIN_SECRET: "test admin"
    bad-key: x
check: { model: flash }
---
Convenciones.
`;

  it("lee servicios, base, script y variables sin romper los roles de alrededor", () => {
    const t = parseTeamFile(file);
    expect(t.setup).toEqual({
      services: ["postgres", "redis"],
      db: "fruteria",
      script: ".ghosty/setup.sh",
      env: { JWT_SECRET: "test-actions-jwt-secret", ADMIN_SECRET: "test admin" },
    });
    expect(t.roles.build?.agent).toBe("Constructor");
    expect(t.roles.check?.model).toBe("flash");
    expect(t.notes).toBe("Convenciones.");
  });

  it("acepta la lista sin corchetes y descarta nombres peligrosos", () => {
    const t = parseTeamFile("---\nsetup:\n  services: postgres\n  db: x; rm -rf /\n  script: ../../etc/passwd\n---\n");
    expect(t.setup).toEqual({ services: ["postgres"], env: {} });
  });

  it("sin setup: no aparece, y la plantilla lo trae comentado dentro del frontmatter", () => {
    expect(parseTeamFile("---\nplan: { agent: P }\n---\nx").setup).toBeUndefined();
    const tpl = teamFileTemplate({});
    expect(parseTeamFile(tpl).setup).toBeUndefined();
    expect(tpl.indexOf("# setup:")).toBeLessThan(tpl.lastIndexOf("---"));
  });

  it("la línea para @build trae la llamada exacta", () => {
    const line = setupLine("o/r", { services: ["postgres"], db: "app", env: { A: "1" } });
    expect(line).toContain('await prepare(box.id, {"services":["postgres"],"db":"app","env":{"A":"1"}})');
  });
});
