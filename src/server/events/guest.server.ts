// Identidad del invitado a un evento.
//
// Hermano de `collab-guest.ts` (los invitados a un documento compartido) y con la
// misma regla, que es la que importa: **el `sub` lo acuña el SERVIDOR**. El
// invitado pone su nombre y su correo; el identificador con el que el sistema lo
// reconoce nunca sale del navegador. Si lo pusiera el cliente, cualquiera podría
// presentarse con el `sub` de un miembro del workspace.
//
// Cookie propia y no la de `collab-guest`: son dos superficies distintas (un
// documento compartido y una sala de evento) y compartir el identificador ataría
// el permiso de una al otro sin que nadie lo pidiera.
//
// Lo que este `sub` NO decide: a qué room entra. Eso sale de su fila en
// `gt_event_registrations`, y lo comprueba `canSeeChannel`.

const COOKIE = "gt_event_guest";

/** `sub` estable del invitado (`guest:<uuid>`): lo lee de la cookie o lo siembra. */
export async function guestSubForEvents(): Promise<string> {
  const { getCookie, setCookie } = await import("@tanstack/react-start/server");
  const previo = getCookie(COOKIE);
  if (previo) return `guest:${previo}`;
  const nuevo = crypto.randomUUID();
  setCookie(COOKIE, nuevo, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    // Más corta que la de documentos (30 días): un evento dura una tarde, y esta
    // cookie es lo que abre el chat de un room público.
    maxAge: 60 * 60 * 24 * 2,
  });
  return `guest:${nuevo}`;
}

/** El `sub` de invitado si ya trae cookie; `null` si nunca se registró. */
export async function currentGuestSub(): Promise<string | null> {
  const { getCookie } = await import("@tanstack/react-start/server");
  const previo = getCookie(COOKIE);
  return previo ? `guest:${previo}` : null;
}
