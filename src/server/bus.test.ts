import { describe, it, expect, vi } from "vitest";
import { addClient, publish, onlineUsers, onlinePeople, touchPresence, ch, type RtEvent } from "./bus.server";
import { IDLE_MS } from "../lib/presence";

// Namespace de tenant para las pruebas: el bus va particionado por `ns` (ver
// bus.server). Un ns fijo aísla estas pruebas de cualquier otro tenant.
const NS = "testns";

describe("bus realtime (fan-out + presencia)", () => {
  it("entrega solo a los suscriptores del canal", () => {
    const a: RtEvent[] = [];
    const b: RtEvent[] = [];
    const unA = addClient(NS, "u1", "U1", [ch.room(NS, 1)], (e) => a.push(e));
    const unB = addClient(NS, "u2", "U2", [ch.room(NS, 2)], (e) => b.push(e));

    publish(ch.room(NS, 1), { t: "typing", sub: "x", name: "X", channelId: 1 });
    expect(a.some((e) => e.t === "typing")).toBe(true);
    expect(b.some((e) => e.t === "typing")).toBe(false); // room 2 no recibe room 1

    unA();
    unB();
  });

  it("deja de entregar tras unsub", () => {
    const got: RtEvent[] = [];
    const un = addClient(NS, "u3", "U3", [ch.room(NS, 9)], (e) => got.push(e));
    un();
    publish(ch.room(NS, 9), { t: "refresh", channelId: 9, parentId: null });
    expect(got.some((e) => e.t === "refresh")).toBe(false);
  });

  it("presencia por conteo de conexiones (online al primero, offline al último)", () => {
    const ev: RtEvent[] = [];
    const watcher = addClient(NS, "w", "W", [ch.presence(NS)], (e) => ev.push(e));
    ev.length = 0; // ignora el 'online' del propio watcher

    const c1 = addClient(NS, "u", "U", [], () => {});
    expect(ev.some((e) => e.t === "presence" && e.status === "online")).toBe(true);
    expect(onlineUsers(NS)).toContain("u");

    ev.length = 0;
    const c2 = addClient(NS, "u", "U", [], () => {}); // 2ª conexión del mismo sub
    expect(ev.some((e) => e.t === "presence")).toBe(false); // no re-anuncia

    c1();
    expect(ev.some((e) => e.t === "presence" && e.status === "offline")).toBe(false); // queda 1

    c2();
    expect(ev.some((e) => e.t === "presence" && e.status === "offline")).toBe(true);
    expect(onlineUsers(NS)).not.toContain("u");

    watcher();
  });

  it("touchPresence sólo anuncia al VOLVER de inactivo (no en cada tecla)", () => {
    const ev: RtEvent[] = [];
    const watcher = addClient(NS, "w2", "W2", [ch.presence(NS)], (e) => ev.push(e));
    const c = addClient(NS, "act", "Act", [], () => {});
    ev.length = 0;

    // Recién conectado ya está activo: una señal más no le dice nada a nadie.
    touchPresence(NS, "act");
    expect(ev.some((e) => e.t === "presence")).toBe(false);

    // El paso a inactivo NO se emite: nadie lo anuncia, el cliente lo deriva del
    // timestamp. Por eso lo que se comprueba aquí es que la lista lo expone.
    const t0 = onlinePeople(NS).find((p) => p.sub === "act")!.lastActiveAt;
    vi.useFakeTimers();
    vi.setSystemTime(t0 + IDLE_MS + 1_000);
    expect(ev.some((e) => e.t === "presence")).toBe(false);

    // Y al volver de inactivo SÍ, porque el resto del workspace no tiene forma de
    // enterarse solo.
    touchPresence(NS, "act");
    expect(ev.some((e) => e.t === "presence" && e.status === "online")).toBe(true);
    vi.useRealTimers();

    // De alguien sin conexión abierta no hay presencia que refrescar (ni evento).
    ev.length = 0;
    touchPresence(NS, "fantasma");
    expect(ev.length).toBe(0);

    c();
    watcher();
  });

  it("aísla por tenant: `room:1` de A no llega a un cliente de B (mismo id, otro ns)", () => {
    const a: RtEvent[] = [];
    const b: RtEvent[] = [];
    const unA = addClient("nsA", "ua", "UA", [ch.room("nsA", 1)], (e) => a.push(e));
    const unB = addClient("nsB", "ub", "UB", [ch.room("nsB", 1)], (e) => b.push(e));

    // Publica al room 1 del tenant A: solo A lo recibe (el prefijo `${ns}|` no matchea B).
    publish(ch.room("nsA", 1), { t: "refresh", channelId: 1, parentId: null });
    expect(a.some((e) => e.t === "refresh")).toBe(true);
    expect(b.some((e) => e.t === "refresh")).toBe(false);

    // Presencia también particionada: un online en A no aparece en B.
    expect(onlineUsers("nsA")).toContain("ua");
    expect(onlineUsers("nsB")).not.toContain("ua");

    unA();
    unB();
  });
});
