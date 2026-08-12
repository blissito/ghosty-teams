import { describe, expect, it, vi } from "vitest";
import { canInvokeAgent, threadVisibleFor, visibleChannelFor } from "./chat";
import type { Channel } from "../db.server";

// Dos server functions del shell servían datos SIN SESIÓN, y las dos se arreglaron
// el 2026-08-11 unificándolas en `visibleChannelFor`:
//
//   · `getChannelView` decía `if (user && !canSeeChannel(...))`. Sin sesión el
//     chequeo se saltaba y `listChannels("")` devolvía TODOS los rooms públicos del
//     workspace — nombres, descripciones y los hilos de cada uno.
//   · `getChannelFlow` no comprobaba nada en absoluto: con el slug alcanzaba para
//     leerse el flujo entero de un room, incluidos los privados. Y el slug es
//     adivinable, porque sale del nombre.
//
// Ninguna era explotable desde la UI (la página está tras el guard de login), y por
// eso llevaban tiempo ahí sin que nadie las notara: son RPC, se llaman sin pasar por
// la página. Lo que las volvió urgentes fue meter tráfico anónimo en ese vecindario
// con las salas de evento.

const PRIVADO = { id: 7, slug: "privado", name: "Privado", is_private: 1 } as Channel;

function db(opts: { existe?: boolean; puedeVer?: boolean } = {}) {
  const getChannel = vi.fn().mockResolvedValue(opts.existe === false ? null : PRIVADO);
  const canSeeChannel = vi.fn().mockResolvedValue(opts.puedeVer ?? false);
  return { getChannel, canSeeChannel };
}

describe("visibleChannelFor", () => {
  it("SIN SESIÓN no devuelve el room, y ni siquiera pregunta si podría verlo", async () => {
    const d = db({ puedeVer: true }); // aunque el permiso dijera que sí
    expect(await visibleChannelFor("privado", null, d)).toBeNull();
    // Lo que de verdad se fija: un anónimo no llega ni al chequeo. Antes el
    // `user && …` lo saltaba y seguía de largo hasta servir los datos.
    expect(d.canSeeChannel).not.toHaveBeenCalled();
  });

  it("con sesión pero sin permiso, tampoco", async () => {
    const d = db({ puedeVer: false });
    expect(await visibleChannelFor("privado", { sub: "ajeno", isOwner: false }, d)).toBeNull();
    expect(d.canSeeChannel).toHaveBeenCalledWith(PRIVADO, "ajeno", false);
  });

  it("con sesión y permiso, devuelve el room", async () => {
    const d = db({ puedeVer: true });
    expect(await visibleChannelFor("privado", { sub: "ana", isOwner: false }, d)).toEqual(PRIVADO);
  });

  it("un room que no existe es null, y no se consulta permiso sobre la nada", async () => {
    const d = db({ existe: false, puedeVer: true });
    expect(await visibleChannelFor("fantasma", { sub: "ana", isOwner: false }, d)).toBeNull();
    expect(d.canSeeChannel).not.toHaveBeenCalled();
  });

  it("el owner pasa por canSeeChannel igual — el atajo es de ALLÁ, no de aquí", async () => {
    // Importa: si el atajo del owner se duplicara aquí, dejarían de coincidir el día
    // que canSeeChannel cambie (y ya sabe resolver invitados de evento, que no son
    // ni miembros ni owners).
    const d = db({ puedeVer: true });
    await visibleChannelFor("privado", { sub: "jefa", isOwner: true }, d);
    expect(d.canSeeChannel).toHaveBeenCalledWith(PRIVADO, "jefa", true);
  });
});

// ── getThread ───────────────────────────────────────────────────────────────
// El mismo agujero, un año después y peor: `getThread` no comprobaba NADA. El
// `messageId` es un entero autoincremental, o sea que se enumera de uno en uno: con
// un for de 1 a N se vaciaban los hilos de todos los rooms privados y todos los DMs
// del tenant, sin sesión.

const MSG_ROOM = { channel_id: 7, dm_id: null };
const MSG_DM = { channel_id: 0, dm_id: 3 };

function dbHilo(opts: { puedeVer?: boolean; miembrosDm?: string[]; canal?: Channel | null } = {}) {
  return {
    getChannelById: vi.fn().mockResolvedValue(opts.canal === undefined ? PRIVADO : opts.canal),
    canSeeChannel: vi.fn().mockResolvedValue(opts.puedeVer ?? false),
    getDmMembers: vi.fn().mockResolvedValue(opts.miembrosDm ?? []),
  };
}

describe("threadVisibleFor", () => {
  it("SIN SESIÓN es que no, y no se consulta nada", async () => {
    const d = dbHilo({ puedeVer: true });
    expect(await threadVisibleFor(MSG_ROOM, null, d)).toBe(false);
    expect(d.canSeeChannel).not.toHaveBeenCalled();
    expect(d.getChannelById).not.toHaveBeenCalled();
  });

  it("el permiso se pregunta sobre el ROOM del mensaje, no sobre el mensaje", async () => {
    const d = dbHilo({ puedeVer: false });
    expect(await threadVisibleFor(MSG_ROOM, { sub: "ajeno", isOwner: false }, d)).toBe(false);
    expect(d.getChannelById).toHaveBeenCalledWith(7);
    expect(d.canSeeChannel).toHaveBeenCalledWith(PRIVADO, "ajeno", false);
  });

  it("con permiso sobre el room, sí", async () => {
    const d = dbHilo({ puedeVer: true });
    expect(await threadVisibleFor(MSG_ROOM, { sub: "ana", isOwner: false }, d)).toBe(true);
  });

  it("en un DM decide la MEMBRESÍA del DM, y ni se toca canSeeChannel", async () => {
    const d = dbHilo({ miembrosDm: ["ana", "beto"], puedeVer: true });
    expect(await threadVisibleFor(MSG_DM, { sub: "ana", isOwner: false }, d)).toBe(true);
    expect(await threadVisibleFor(MSG_DM, { sub: "curiosa", isOwner: false }, d)).toBe(false);
    expect(d.canSeeChannel).not.toHaveBeenCalled();
  });

  it("el OWNER no entra a los DMs ajenos por ser owner", async () => {
    // El bypass de owner vale para rooms, no para conversaciones privadas entre dos
    // personas. Si algún día se quisiera, sería una decisión explícita — no un efecto
    // secundario de reusar el atajo del sidebar.
    const d = dbHilo({ miembrosDm: ["ana", "beto"], puedeVer: true });
    expect(await threadVisibleFor(MSG_DM, { sub: "jefa", isOwner: true }, d)).toBe(false);
  });

  it("un mensaje que no existe es que no", async () => {
    const d = dbHilo({ puedeVer: true });
    expect(await threadVisibleFor(null, { sub: "ana", isOwner: false }, d)).toBe(false);
  });

  it("si el room del mensaje ya no existe, tampoco", async () => {
    const d = dbHilo({ canal: null, puedeVer: true });
    expect(await threadVisibleFor(MSG_ROOM, { sub: "ana", isOwner: false }, d)).toBe(false);
  });
});

// ── askAgent ────────────────────────────────────────────────────────────────
// El más caro de los cuatro: no comprobaba nada y un turno de agente CUESTA DINERO
// del dueño. No hay enforcement de saldo en ninguna parte del sistema, así que el
// límite de lo que un desconocido podía gastar era su paciencia.

const EVENTO = { id: 9, slug: "webinar", name: "Webinar", is_private: 0, call_mode: "webinar" } as Channel;

describe("canInvokeAgent", () => {
  const dbNormal = (puedeVer: boolean) => ({ canSeeChannel: vi.fn().mockResolvedValue(puedeVer) });
  const sinInvitado = vi.fn().mockResolvedValue(null);

  it("room normal SIN SESIÓN: no", async () => {
    const d = dbNormal(true);
    expect(await canInvokeAgent(PRIVADO, null, d, sinInvitado)).toBe(false);
    expect(d.canSeeChannel).not.toHaveBeenCalled();
  });

  it("room normal con sesión pero sin acceso: no", async () => {
    expect(await canInvokeAgent(PRIVADO, { sub: "ajeno", isOwner: false }, dbNormal(false), sinInvitado)).toBe(false);
  });

  it("room normal con acceso: sí", async () => {
    expect(await canInvokeAgent(PRIVADO, { sub: "ana", isOwner: false }, dbNormal(true), sinInvitado)).toBe(true);
  });

  it("un room NORMAL nunca pregunta por invitados de evento", async () => {
    // Si lo hiciera, `eventViewerFor` sería una segunda puerta a todos los rooms.
    const espia = vi.fn().mockResolvedValue({ sub: "guest:x" });
    await canInvokeAgent(PRIVADO, { sub: "ana", isOwner: false }, dbNormal(true), espia);
    expect(espia).not.toHaveBeenCalled();
  });

  it("en un EVENTO, un invitado registrado SÍ puede — es el caso que hay que soportar", async () => {
    const invitado = vi.fn().mockResolvedValue({ sub: "guest:abc", isMember: false });
    // Sin sesión de miembro: es exactamente quien entra por la liga pública.
    expect(await canInvokeAgent(EVENTO, null, dbNormal(false), invitado)).toBe(true);
  });

  it("en un EVENTO, quien no se registró no puede aunque el room sea público", async () => {
    // `eventViewerFor` devuelve null si no hay fila de registro o si está baneado.
    expect(await canInvokeAgent(EVENTO, null, dbNormal(true), sinInvitado)).toBe(false);
  });
});
