import { test, expect } from "vitest";
import { makePreviewTicket, redeemPreviewTicket, TICKET_TTL_MS } from "./preview-ticket";

test("el boleto abre su pedido una sola vez", () => {
  const t = makePreviewTicket(184, "s3cret", 1000);
  expect(redeemPreviewTicket(t, 184, "s3cret", 2000)).toBe(true);
  expect(redeemPreviewTicket(t, 184, "s3cret", 3000)).toBe(false);
});

test("otro pedido, otro secreto, caducado o alterado: no", () => {
  expect(redeemPreviewTicket(makePreviewTicket(184, "s", 0), 185, "s", 1)).toBe(false);
  expect(redeemPreviewTicket(makePreviewTicket(184, "s", 0), 184, "otro", 1)).toBe(false);
  expect(redeemPreviewTicket(makePreviewTicket(184, "s", 0), 184, "s", TICKET_TTL_MS + 1)).toBe(false);
  const t = makePreviewTicket(184, "s", 0);
  expect(redeemPreviewTicket(t.slice(0, -2) + "xx", 184, "s", 1)).toBe(false);
  expect(redeemPreviewTicket("basura", 184, "s", 1)).toBe(false);
});
