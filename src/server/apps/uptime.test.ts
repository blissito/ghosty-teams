import { describe, it, expect } from "vitest";
import { downFor, isUp, uptimeStep, urlLabel, type UptimeState } from "./uptime.server";

describe("uptimeStep", () => {
  it("arriba → 1 falla (sin aviso) → caído (aviso) → sigue caído (sin aviso) → volvió", () => {
    let s: UptimeState = { state: "up", fails: 0 };
    const events: (string | null)[] = [];
    for (const ok of [true, false, false, false, false, true, true]) {
      const r = uptimeStep(s, ok);
      events.push(r.event);
      s = r.next;
    }
    expect(events).toEqual([null, null, "down", null, null, "recovered", null]);
    expect(s).toEqual({ state: "up", fails: 0 });
  });

  it("una falla suelta no tumba nada", () => {
    const a = uptimeStep({ state: "up", fails: 0 }, false);
    expect(a).toEqual({ next: { state: "up", fails: 1 }, event: null });
    expect(uptimeStep(a.next, true)).toEqual({ next: { state: "up", fails: 0 }, event: null });
  });

  it("se avisa UNA vez por caída", () => {
    let s: UptimeState = { state: "up", fails: 0 };
    let downs = 0;
    for (let i = 0; i < 20; i++) {
      const r = uptimeStep(s, false);
      if (r.event === "down") downs++;
      s = r.next;
    }
    expect(downs).toBe(1);
  });
});

describe("isUp / urlLabel / downFor", () => {
  it("arriba = < 400", () => {
    expect(isUp(200)).toBe(true);
    expect(isUp(301)).toBe(true);
    expect(isUp(404)).toBe(false);
    expect(isUp(502)).toBe(false);
    expect(isUp(null)).toBe(false);
  });
  it("etiqueta corta", () => {
    expect(urlLabel("https://www.denik.me/")).toBe("denik.me");
    expect(urlLabel("https://denik.me/planes/")).toBe("denik.me/planes");
  });
  it("duración", () => {
    expect(downFor(30)).toBe("1 min");
    expect(downFor(7 * 60)).toBe("7 min");
    expect(downFor(65 * 60)).toBe("1 h 5 min");
  });
});
