import { describe, expect, it, vi } from "vitest";
import { visibleChannelFor } from "./chat";
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
