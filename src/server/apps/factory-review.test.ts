import { describe, it, expect } from "vitest";
// Revisión y comentarios de la fábrica al día con las automatizaciones (26-oct): severidad mínima
// en la revisión suelta de @check, CLAUDE.md como reglas del repo y comentarios en línea sin
// @ghosty en el PR de un pedido.
import { loosePrReviewBrief } from "./factory-roles";
import { knowledgeLine, parseTeamFile } from "./factory-team";
import { parseSeverity, severityRule } from "../automations/severity";
import { factoryReviewCommentAsk, prReviewPrompt, REPO_RULES } from "../automations/pr-review.server";
import { routeFactoryReviewComment } from "./factory-review-comments.server";
import type { RepoEvent } from "../automations/types";
import type { Run } from "./factory-runs.server";

describe("revisión suelta de @check con severidad mínima", () => {
  it("sin severidad fijada: el texto de siempre (aprueba o bloquea)", () => {
    expect(loosePrReviewBrief()).toBe(loosePrReviewBrief({ minSeverity: null }));
    expect(loosePrReviewBrief()).toContain("APPROVE o REQUEST_CHANGES");
    expect(loosePrReviewBrief()).not.toContain("Sin hallazgos graves");
  });

  it("con P0: sólo bloquea lo de esa severidad y acepta «Sin hallazgos graves»", () => {
    const b = loosePrReviewBrief({ minSeverity: "P0" });
    expect(b).toContain("REQUEST_CHANGES sólo si hay hallazgos de esa severidad");
    expect(b).toContain(severityRule("P0"));
    expect(b).toContain("«Sin hallazgos graves»");
  });

  it("la automatización (commentOnly) no cambia: su severidad la pone prReviewPrompt", () => {
    expect(loosePrReviewBrief({ commentOnly: true, minSeverity: "P2" })).toBe(loosePrReviewBrief({ commentOnly: true }));
    const ev = { deliveryId: "d", event: "pull_request", action: "opened", repo: "o/r", pr: { number: 1, headSha: "s" } } as RepoEvent;
    expect(prReviewPrompt(ev, "P2")).toContain(severityRule("P2"));
  });

  it("parseSeverity: sólo P0/P1/P2", () => {
    expect(parseSeverity("p2")).toBe("P2");
    expect(parseSeverity(" P0 ")).toBe("P0");
    expect(parseSeverity("P3")).toBeNull();
    expect(parseSeverity(undefined)).toBeNull();
  });

  it("`.ghosty/factory.md` con review_severity", () => {
    const f = parseTeamFile("---\ncheck: { model: opus }\nreview_severity: P0   # sólo lo grave\n---\nNotas");
    expect(f.reviewSeverity).toBe("P0");
    expect(f.roles.check?.model).toBe("opus");
    expect(parseTeamFile("---\nreview_severity: P9\n---\n").reviewSeverity).toBeUndefined();
    expect(parseTeamFile("---\ncheck: { model: opus }\n---\n").reviewSeverity).toBeUndefined();
  });
});

describe("reglas del repo: AGENTS.md o CLAUDE.md", () => {
  it("la fábrica pide el más cercano de los dos, igual que las automatizaciones", () => {
    for (const line of [knowledgeLine("a/b", []), knowledgeLine("a/b", ["x.md"])]) {
      expect(line).toContain("AGENTS.md o CLAUDE.md más cercano");
    }
    expect(REPO_RULES).toContain("AGENTS.md o CLAUDE.md más cercano a los archivos que cambian (y el de la raíz)");
  });
});

const ev = (over: Partial<RepoEvent> = {}, comment: Partial<NonNullable<RepoEvent["comment"]>> = {}): RepoEvent => ({
  deliveryId: "d",
  event: "pull_request_review_comment",
  action: "created",
  repo: "o/r",
  sender: { login: "ana", type: "User" },
  pr: { number: 8, url: "https://github.com/o/r/pull/8", head: "ghosty/x" },
  comment: { id: 5, body: "Aquí falta validar el correo", path: "src/a.ts", line: 12, author: "ana", url: "https://github.com/o/r/pull/8#discussion_r5", ...comment },
  ...over,
});

describe("comentario en línea sin @ghosty en el PR de un pedido", () => {
  it("es pedido: con archivo, línea y liga", () => {
    expect(factoryReviewCommentAsk(ev())).toEqual({
      by: "ana",
      text: "Aquí falta validar el correo",
      url: "https://github.com/o/r/pull/8#discussion_r5",
      path: "src/a.ts",
      line: 12,
      kind: "review_comment",
    });
  });

  it("anti-bucle: bots, @ghosty (ya va por gs), vacío u otro evento no", () => {
    expect(factoryReviewCommentAsk(ev({ sender: { login: "ghosty-studio[bot]", type: "Bot" } }))).toBeNull();
    expect(factoryReviewCommentAsk(ev({}, { author: "coderabbitai[bot]" }))).toBeNull();
    expect(factoryReviewCommentAsk(ev({}, { body: "@ghosty arréglalo" }))).toBeNull();
    expect(factoryReviewCommentAsk(ev({}, { body: "  " }))).toBeNull();
    expect(factoryReviewCommentAsk(ev({ action: "edited" }))).toBeNull();
    expect(factoryReviewCommentAsk(ev({ event: "issue_comment" }))).toBeNull();
  });

  const run = (id: number, status: Run["status"]) => ({ id, status }) as Run;

  it("llega a @build de cada pedido abierto del PR, sólo si quien comenta escribe en el repo", async () => {
    const noted: { id: number; by: string; kind: string }[] = [];
    const deps = {
      runsByPr: async () => [run(1, "pr_review"), run(2, "done")],
      canWrite: async (_r: string, login: string) => login === "ana",
      note: async (r: Run, by: string, ask: { kind: string }) => (noted.push({ id: r.id, by, kind: ask.kind }), "reopened"),
    };
    expect(await routeFactoryReviewComment(ev(), deps)).toEqual(["reopened"]);
    expect(noted).toEqual([{ id: 1, by: "ana", kind: "review_comment" }]);
    noted.length = 0;
    expect(await routeFactoryReviewComment(ev({ sender: { login: "extraño" } }, { author: "extraño" }), deps)).toEqual([]);
    expect(noted).toHaveLength(0);
  });

  it("PR sin pedido: no hace nada (lo atiende review_autofix si está prendida)", async () => {
    let asked = false;
    const deps = { runsByPr: async () => [], canWrite: async () => ((asked = true), true), note: async () => "x" };
    expect(await routeFactoryReviewComment(ev(), deps)).toEqual([]);
    expect(asked).toBe(false);
  });
});
