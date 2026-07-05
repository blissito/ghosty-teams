import { describe, it, expect } from "vitest";
import { addClient, publish, onlineUsers, ch, type RtEvent } from "./bus.server";

describe("bus realtime (fan-out + presencia)", () => {
  it("entrega solo a los suscriptores del canal", () => {
    const a: RtEvent[] = [];
    const b: RtEvent[] = [];
    const unA = addClient("u1", "U1", [ch.room(1)], (e) => a.push(e));
    const unB = addClient("u2", "U2", [ch.room(2)], (e) => b.push(e));

    publish(ch.room(1), { t: "typing", sub: "x", name: "X", channelId: 1 });
    expect(a.some((e) => e.t === "typing")).toBe(true);
    expect(b.some((e) => e.t === "typing")).toBe(false); // room 2 no recibe room 1

    unA();
    unB();
  });

  it("deja de entregar tras unsub", () => {
    const got: RtEvent[] = [];
    const un = addClient("u3", "U3", [ch.room(9)], (e) => got.push(e));
    un();
    publish(ch.room(9), { t: "refresh", channelId: 9, parentId: null });
    expect(got.some((e) => e.t === "refresh")).toBe(false);
  });

  it("presencia por conteo de conexiones (online al primero, offline al último)", () => {
    const ev: RtEvent[] = [];
    const watcher = addClient("w", "W", [ch.presence()], (e) => ev.push(e));
    ev.length = 0; // ignora el 'online' del propio watcher

    const c1 = addClient("u", "U", [], () => {});
    expect(ev.some((e) => e.t === "presence" && e.status === "online")).toBe(true);
    expect(onlineUsers()).toContain("u");

    ev.length = 0;
    const c2 = addClient("u", "U", [], () => {}); // 2ª conexión del mismo sub
    expect(ev.some((e) => e.t === "presence")).toBe(false); // no re-anuncia

    c1();
    expect(ev.some((e) => e.t === "presence" && e.status === "offline")).toBe(false); // queda 1

    c2();
    expect(ev.some((e) => e.t === "presence" && e.status === "offline")).toBe(true);
    expect(onlineUsers()).not.toContain("u");

    watcher();
  });
});
