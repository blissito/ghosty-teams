// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

// Pedido escalado: el paso actual le toca a la PERSONA y la tarjeta lo dice (antes se veía
// «Check» como si @check siguiera trabajando).
vi.mock("../../i18n", () => ({ useT: () => (s: string) => s }));
vi.mock("../../utils/rt-bus", () => ({ useRtSubscribe: () => {} }));
const runs: Record<number, object> = {
  12: { runId: 12, title: "CLI", status: "pr_review", planVersion: 2, loops: 0, canSign: false, prUrl: "https://github.com/o/r/pull/34", preview: null, repo: "o/r", threadUrl: "/c/dev?thread=98", ci: { state: "pending", repoHasCi: true }, mergeQueued: true },
  11: { runId: 11, title: "CLI", status: "pr_review", planVersion: 2, loops: 1, canSign: false, prUrl: "https://github.com/o/r/pull/34", preview: null, repo: "o/r", threadUrl: "/c/dev?thread=98", ci: { state: "success", repoHasCi: true } },
};
vi.mock("../../server/apps/factory", () => ({
  factoryVerdictFn: async ({ data }: { data: { runId: number } }) => ({
    ci: data.runId === 12
      ? { state: "pending", repoHasCi: true, checks: [{ name: "verify", state: "pending", seconds: 60, url: null }, { name: "lint", state: "success", seconds: 9, url: null }] }
      : { state: "success", repoHasCi: true, checks: [] },
    runId: 11, title: "CLI", status: "pr_review", repo: "o/r", prUrl: "https://github.com/o/r/pull/34", shots: [], preview: { state: "off" },
    effort: { score: 5, label: "Muy complejo", minutes: 35, reasons: ["1,351 líneas en 24 archivos"] }, relay: [], approvedAt: null, branch: null, events: 0,
    verdict: { prNumber: 34, files: 24, additions: 1339, deletions: 12, ci: "success", ready: true, planVersion: 2, loops: 1, findings: "",
      risk: "high", riskReasons: ["size"], summary: "La CLI ya transfiere dominios.", tryIt: "Corre `cli transfers dns`.",
      readFirst: [{ file: "cli/src/commands/transfers.ts", lines: "11-31", why: "valida antes de tocar la red", href: "https://github.com/o/r/pull/34/files#diff-abcR11" }] },
  }),
  factoryMergeFn: async () => ({}),
  factoryRunCardFn: async ({ data }: { data: { runId: number } }) => runs[data.runId] ?? ({
    runId: 10, title: "Docs", status: "escalated", planVersion: 1, loops: 3, canSign: true,
    prUrl: null, preview: null, repo: "o/r", threadUrl: "/c/dev?thread=99",
    escalation: { points: ["`ci.yml:51` agrega un paso", "dos cifras de vendido hoy", "c", "d"], at: 1 },
  }),
  factoryDecisionFn: async () => ({}),
  factoryRetryPreviewFn: async () => ({}),
  factorySetPreviewOffFn: async () => ({}),
}));

import { RunCard, escalationLine } from "./RunCard";

describe("RunCard escalado", () => {
  it("muestra «Te toca decidir» y qué pasó", async () => {
    render(<RunCard card={{ runId: 10 } as never} channelId={3} />);
    await waitFor(() => expect(screen.getByText("Te toca decidir")).toBeTruthy());
    expect(screen.getByText("3 vueltas sin cerrar: ¿otra vuelta o replanear?")).toBeTruthy();
    expect(screen.getByText("Otra vuelta")).toBeTruthy();
  });

  it("pinta los puntos arriba y aprobar pide un 2º clic", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<RunCard card={{ runId: 10 } as never} channelId={3} />);
    await waitFor(() => expect(screen.getByText("Lo que @check pide decidir:")).toBeTruthy());
    expect(screen.getByText("dos cifras de vendido hoy")).toBeTruthy();
    expect(screen.queryByText("d")).toBeNull();
    fireEvent.click(screen.getByText("Otra vuelta"));
    expect(screen.getByText("Leí los {n} puntos: otra vuelta".replace("{n}", "4"))).toBeTruthy();
    expect(screen.getByText("d")).toBeTruthy();
  });

  it("escalado sin agotar vueltas: @build no puede resolverlo", () => {
    expect(escalationLine(1, (s) => s)).toContain("@build no puede resolverlo");
  });
});

describe("RunCard con el PR listo", () => {
  it("en el room AVISA: a quién le toca, esfuerzo y qué cambia; la revisión se abre en el panel", async () => {
    render(<RunCard card={{ runId: 11 } as never} channelId={3} />);
    await waitFor(() => expect(screen.getByText("La CLI ya transfiere dominios.")).toBeTruthy());
    expect(screen.getByText("Te toca revisar")).toBeTruthy();
    expect(screen.getByText(/esfuerzo 5\/5 · ~35 min/)).toBeTruthy();
    expect(screen.getByText("Revisar")).toBeTruthy();
    // Lo que antes llenaba la tarjeta ya no está aquí.
    expect(screen.queryByText("Lee primero")).toBeNull();
    expect(screen.queryByText("Merge")).toBeNull();
    expect(screen.queryByText(/La fábrica terminó su parte/)).toBeNull();
  });
});

describe("RunCard con merge en cola", () => {
  it("el anillo dice cuántos checks van y la línea, que el merge entra solo", async () => {
    render(<RunCard card={{ runId: 12 } as never} channelId={3} />);
    await waitFor(() => expect(screen.getByText("Merge en cola: entra solo cuando pase el CI")).toBeTruthy());
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});

describe("RunCard al mezclarse", () => {
  it("celebra en el room sólo en la transición a terminado", async () => {
    window.matchMedia = (() => ({ matches: false })) as never;
    const { act } = await import("@testing-library/react");
    let refreshEv: ((ev: unknown) => void) | undefined;
    const bus = await import("../../utils/rt-bus");
    vi.spyOn(bus, "useRtSubscribe").mockImplementation(((o: { onEvent: (ev: unknown) => void }) => { refreshEv = o.onEvent; }) as never);
    runs[13] = { ...runs[11], runId: 13, status: "pr_review" };
    const { container } = render(<RunCard card={{ runId: 13 } as never} channelId={3} />);
    await waitFor(() => expect(screen.getByText("Te toca revisar")).toBeTruthy());
    expect(container.querySelector(".gt-fx-confetti")).toBeNull();
    runs[13] = { ...runs[13], status: "done", prod: null };
    await act(async () => refreshEv?.({ t: "refresh", channelId: 3 }));
    await waitFor(() => expect(container.querySelector(".gt-fx-confetti")).toBeTruthy());
  });
});
