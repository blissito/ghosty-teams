import { describe, expect, it } from "vitest";
import { isBotActor, shouldTriage, triageClaimKey, triagePrompt } from "./issue-triage.server";
import type { RepoEvent } from "./types";

const ev = (o: Partial<RepoEvent> = {}): RepoEvent => ({
  deliveryId: "d", event: "issues", action: "opened", repo: "Owner/Repo",
  sender: { login: "ana", type: "User" }, issue: { number: 7, title: "Se cae al guardar", author: "ana" }, ...o,
});

describe("shouldTriage", () => {
  it("issue abierto o reabierto por una persona", () => {
    expect(shouldTriage(ev())).toBe(true);
    expect(shouldTriage(ev({ action: "reopened" }))).toBe(true);
  });
  it("otras acciones o eventos no", () => {
    expect(shouldTriage(ev({ action: "edited" }))).toBe(false);
    expect(shouldTriage(ev({ event: "issue_comment" }))).toBe(false);
  });
  it("bots fuera (el nuestro, dependabot, type Bot)", () => {
    expect(shouldTriage(ev({ sender: { login: "ghosty-studio[bot]" } }))).toBe(false);
    expect(shouldTriage(ev({ sender: { login: "renovate", type: "Bot" } }))).toBe(false);
    expect(shouldTriage(ev({ issue: { number: 7, author: "dependabot[bot]" } }))).toBe(false);
    expect(isBotActor("ana", "User")).toBe(false);
  });
});

describe("triage", () => {
  it("una clave por issue, sin importar mayúsculas", () => {
    expect(triageClaimKey("Owner/Repo", 7)).toBe("owner/repo#7");
  });
  it("sin createLabels prohíbe crear etiquetas; con él lo permite", () => {
    expect(triagePrompt(ev(), {})).toContain("Nunca crees etiquetas");
    expect(triagePrompt(ev(), { createLabels: true })).toContain("github_label_write");
  });
  it("askRepro:false quita la pregunta de reproducción", () => {
    expect(triagePrompt(ev(), {})).toContain("pasos para reproducirlo");
    expect(triagePrompt(ev(), { askRepro: false })).not.toContain("pasos para reproducirlo");
  });
});
