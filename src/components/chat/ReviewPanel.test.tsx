// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);
vi.mock("../../i18n", () => ({ useT: () => (s: string) => s }));
vi.mock("../../utils/rt-bus", () => ({ useRtSubscribe: () => {} }));
vi.mock("./PlanCard", () => ({ PlanCard: () => null }));
vi.mock("./message", () => ({ ChatCtx: { Provider: () => null } }));
vi.mock("../../server/apps/factory", () => ({
  factoryMergeFn: async () => ({}),
  factoryFixCiFn: async () => ({}),
  factoryRetryPreviewFn: async () => ({}),
  factorySetPreviewOffFn: async () => ({}),
  factoryVerdictFn: async () => ({
    runId: 23, title: "CLI de dominios", status: "pr_review", repo: "o/r", prUrl: "https://github.com/o/r/pull/34", shots: [], preview: { state: "off" },
    mergeQueued: false, branch: "feat/cli", approvedAt: 1, events: 9,
    ci: { state: "pending", repoHasCi: true, checks: [{ name: "verify", state: "pending", seconds: 100, url: null }, { name: "lint", state: "success", seconds: 9, url: null }] },
    effort: { score: 4, label: "Delicado", minutes: 25, reasons: ["1,351 líneas en 24 archivos", "toca la API pública"] },
    relay: [{ who: "plan", seconds: 240 }, { who: "build", seconds: 1320 }, { who: "check", seconds: 360 }, { who: "you", seconds: 180 }],
    verdict: { prNumber: 34, files: 24, additions: 1339, deletions: 12, ci: "success", ready: true, planVersion: 2, loops: 0, findings: "",
      summary: "La CLI ya transfiere dominios.", readFirst: [{ file: "cli/src/transfers.ts", lines: "11-31", why: "valida antes de tocar la red" }] },
  }),
}));

import { ReviewPanel } from "./ReviewPanel";

describe("ReviewPanel", () => {
  it("abre con el esfuerzo, cuenta la estafeta y ofrece merge cuando pase el CI", async () => {
    render(<ReviewPanel runId={23} channelId={3} />);
    await waitFor(() => expect(screen.getByText("Revísalo con calma · ~25 min")).toBeTruthy());
    expect(screen.getByText("toca la API pública")).toBeTruthy();
    expect(screen.getByText("22m")).toBeTruthy(); // @build
    expect(screen.getByText("Te toca revisar")).toBeTruthy();
    expect(screen.getByText("transfers.ts")).toBeTruthy();
    expect(screen.getByText("Merge cuando pase el CI")).toBeTruthy();
    expect(screen.getByText("verify")).toBeTruthy();
  });
});
