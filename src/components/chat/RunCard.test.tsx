// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

// Pedido escalado: el paso actual le toca a la PERSONA y la tarjeta lo dice (antes se veía
// «Check» como si @check siguiera trabajando).
vi.mock("../../i18n", () => ({ useT: () => (s: string) => s }));
vi.mock("../../utils/rt-bus", () => ({ useRtSubscribe: () => {} }));
vi.mock("../../server/apps/factory", () => ({
  factoryRunCardFn: async () => ({
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
