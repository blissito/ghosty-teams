import { beforeEach, describe, expect, it, vi } from "vitest";

// Hasta ahora `notifyMentions` tenía UN solo call site: el post de un mensaje HUMANO. El
// agente publica por otro camino (postAgent → setMessageBody) y nunca la llamaba, así que
// un "@ana revisa esto" escrito por el agente se pintaba en el chat y a Ana no le llegaba
// nada. El turno cerraba en verde: el fallo mudo de siempre.
//
// Estos tests fijan las cuatro decisiones que hacen que el arreglo no se convierta en otro
// problema: sin @todos, sin @ de dentro de un documento, sin avisos a quien no puede ver el
// room, y sin silencio cuando un handle no resolvió.

const resolveMentionedUsers = vi.fn();
const listUsers = vi.fn();
const listChannelMembers = vi.fn();
const listRoomRoster = vi.fn();
const filterMutedOut = vi.fn();
const notify = vi.fn();

vi.mock("../users.server", () => ({
  resolveMentionedUsers: (...a: unknown[]) => resolveMentionedUsers(...a),
  resolveMentionedUserSubs: async (...a: unknown[]) =>
    (await resolveMentionedUsers(...a)).map((u: { sub: string }) => u.sub),
  listUsers: (...a: unknown[]) => listUsers(...a),
}));
vi.mock("../db.server", () => ({
  listChannelMembers: (...a: unknown[]) => listChannelMembers(...a),
  listRoomRoster: (...a: unknown[]) => listRoomRoster(...a),
  filterMutedOut: (...a: unknown[]) => filterMutedOut(...a),
}));
vi.mock("./notify.server", () => ({ notify: (...a: unknown[]) => notify(...a) }));

const { notifyMentions, notificarMencionesDelAgente } = await import("./mentions.server");

const ROOM = { id: 7, slug: "general", name: "general", is_private: 0 } as never;
const PRIVADO = { id: 7, slug: "legal", name: "legal", is_private: 1 } as never;

beforeEach(() => {
  vi.resetAllMocks();
  // Por defecto: `@ana` existe, nadie silenció nada.
  // El corte con lista vacía es del real (`if (!handles.length) return []`) y hay que
  // replicarlo: sin él, el test de @todos pasaría por un artefacto del mock.
  resolveMentionedUsers.mockImplementation(async (handles: string[]) =>
    handles.length ? [{ sub: "s-ana", handle: "ana" }] : []
  );
  filterMutedOut.mockImplementation(async (subs: string[]) => subs);
  listUsers.mockResolvedValue([{ sub: "s-ana" }, { sub: "s-beto" }]);
  listChannelMembers.mockResolvedValue(["s-ana", "s-beto"]);
  listRoomRoster.mockResolvedValue([{ sub: "s-ana" }, { sub: "s-beto" }]);
});

describe("notifyMentions con el AGENTE como emisor", () => {
  it("notifica a la persona etiquetada", async () => {
    const r = await notifyMentions("acme", ROOM, "@ana revisa esto", "Ghosty", "", false);
    expect(r.notified).toEqual(["s-ana"]);
    expect(r.unresolved).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toMatchObject({
      kind: "mention",
      recipients: ["s-ana"],
      title: "Ghosty te mencionó en #general",
    });
  });

  it("🔴 `allowGroup:false` ignora @todos: el agente no le suena el teléfono a la empresa", async () => {
    const r = await notifyMentions("acme", ROOM, "@todos junta a las 5", "Ghosty", "", false);
    expect(notify).not.toHaveBeenCalled();
    expect(r.notified).toEqual([]);
    // Y no se reporta como fallo: una grupal no es un handle que "no encontré".
    expect(r.unresolved).toEqual([]);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("una persona SÍ puede usar @todos (allowGroup por defecto)", async () => {
    await notifyMentions("acme", ROOM, "@todos junta a las 5", "Ana", "s-ana");
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0].recipients).toEqual(["s-beto"]);
  });

  it("un handle que no existe sale en `unresolved` y no notifica a nadie", async () => {
    resolveMentionedUsers.mockResolvedValue([]);
    const r = await notifyMentions("acme", ROOM, "@anna revisa esto", "Ghosty", "", false);
    expect(r.unresolved).toEqual(["anna"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("🔴 en un room PRIVADO, quien no es miembro cuenta como no avisado", async () => {
    // Resuelve en gc_users pero no está en el room: notificarle filtraría el excerpt.
    listChannelMembers.mockResolvedValue(["s-beto"]);
    const r = await notifyMentions("acme", PRIVADO, "@ana mira esto", "Ghosty", "", false);
    expect(notify).not.toHaveBeenCalled();
    // Y para quien escribió es el MISMO caso que un handle inventado: nadie recibió aviso.
    expect(r.unresolved).toEqual(["ana"]);
  });

  it("quien silenció el room no aparece en `notified`", async () => {
    filterMutedOut.mockResolvedValue([]);
    const r = await notifyMentions("acme", ROOM, "@ana revisa esto", "Ghosty", "", false);
    expect(notify).not.toHaveBeenCalled();
    expect(r.notified).toEqual([]);
    // Silenciar NO es un fallo que reportarle al agente: la persona está etiquetada y lo
    // ve al entrar; sólo eligió no recibir el timbre.
    expect(r.unresolved).toEqual([]);
  });
});

describe("notificarMencionesDelAgente", () => {
  it("🔴 un @ dentro de un ```eb-doc``` NO es una mención", async () => {
    const reply = [
      "Ya quedó el escrito.",
      "```eb-doc titulo=Contrato",
      "Notificar a @ana en el domicilio señalado.",
      "```",
    ].join("\n");
    const aviso = await notificarMencionesDelAgente("acme", ROOM, reply, "Ghosty");
    expect(notify).not.toHaveBeenCalled();
    expect(aviso).toBe("");
  });

  it("un @ en la prosa sí notifica, aunque el mensaje traiga un documento", async () => {
    const reply = [
      "@ana te dejo el borrador.",
      "```eb-doc titulo=Contrato",
      "Cuerpo del contrato.",
      "```",
    ].join("\n");
    await notificarMencionesDelAgente("acme", ROOM, reply, "Ghosty");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("devuelve el aviso para la burbuja cuando el handle no llegó a nadie", async () => {
    resolveMentionedUsers.mockResolvedValue([]);
    const aviso = await notificarMencionesDelAgente("acme", ROOM, "@anna lo revisa", "Ghosty");
    // Es lo que hace que el agente se entere: el aviso queda en el body, o sea en el
    // historial, y lo lee en el turno siguiente.
    expect(aviso).toContain("@anna");
    expect(aviso).toMatch(/no avis/i);
  });

  it("sin ninguna @ no toca la DB", async () => {
    const aviso = await notificarMencionesDelAgente("acme", ROOM, "Listo, quedó publicado.", "Ghosty");
    expect(aviso).toBe("");
    expect(resolveMentionedUsers).not.toHaveBeenCalled();
  });
});

describe("mentionGapNotice", () => {
  it("sin huecos no dice nada (el camino normal no ensucia la burbuja)", async () => {
    const { mentionGapNotice } = await import("./artifacts");
    expect(mentionGapNotice([])).toBe("");
  });

  it("nombra el handle que falló, que es donde está la causa a la vista", async () => {
    const { mentionGapNotice } = await import("./artifacts");
    expect(mentionGapNotice(["anna"])).toContain("`@anna`");
    const varios = mentionGapNotice(["a", "b", "c", "d"]);
    expect(varios).toContain("`@a`");
    expect(varios).toContain("y 1 más");
  });
});
