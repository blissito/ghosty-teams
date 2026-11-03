import { describe, it, expect, vi, beforeEach } from "vitest";

// Merge perdido (3-nov, business #162): el deploy reinició Teams a media operación del merge en
// cola y el pedido quedó aprobado, en verde y sin volver a formarse. `lostMergeActor` decide si
// se retoma solo: sólo cuando lo último fue formarlo y hace más de 5 min.
let lastEvent: Record<string, unknown> | null = null;
vi.mock("../../dbq.server", () => ({
  dbq: async (sql: string) => (sql.includes("FROM gt_factory_events") && lastEvent ? [lastEvent] : []),
}));
vi.mock("../../db.server", () => ({}));
vi.mock("../notify.server", () => ({ notify: async () => {} }));
vi.mock("../bus.server", () => ({ publish: () => {}, ch: { room: () => "r" } }));
vi.mock("../tenant.server", () => ({ currentNamespace: async () => "ns" }));

import { lostMergeActor } from "./factory-runs.server";

const now = () => Math.floor(Date.now() / 1000);

describe("merge en cola interrumpido", () => {
  beforeEach(() => (lastEvent = null));

  it("formado hace 8 min y nada después → se retoma a nombre de quien firmó", async () => {
    lastEvent = { type: "merge_queued", actor: "brenda", at: now() - 480 };
    expect(await lostMergeActor(162)).toBe("brenda");
  });

  it("formado hace 1 min → no: puede estar entrando ahora mismo", async () => {
    lastEvent = { type: "merge_queued", actor: "brenda", at: now() - 60 };
    expect(await lostMergeActor(162)).toBeNull();
  });

  it("el último fue un fallo avisado → no se reintenta en bucle", async () => {
    lastEvent = { type: "merge_failed", actor: "brenda", at: now() - 900 };
    expect(await lostMergeActor(162)).toBeNull();
  });

  it("ya se recuperó una vez → no se vuelve a formar (el candado se encarga)", async () => {
    lastEvent = { type: "merge_requeued", actor: "brenda", at: now() - 900 };
    expect(await lostMergeActor(162)).toBeNull();
  });

  it("sin eventos → no", async () => {
    expect(await lostMergeActor(162)).toBeNull();
  });
});
