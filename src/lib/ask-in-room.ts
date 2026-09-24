// Mandar un mensaje a un room Y despertar a los agentes que menciona, desde fuera del
// composer (botones «Pedir», «?» de ayuda). `postMessage` sólo deja el mensaje y la cáscara:
// el TURNO lo dispara el cliente con `askAgent`, igual que el composer del chat. Sin esa
// llamada el agente mencionado nunca contesta.
import { askAgent, postMessage } from "../server/chat";

/** Publica `body` top-level en `slug` y despierta a quien mencione. Devuelve la liga al hilo. */
export async function askInRoom(slug: string, body: string): Promise<{ threadUrl: string }> {
  const r = await postMessage({ data: { slug, parentId: null, body } });
  if (!r.ok) throw new Error("no se pudo enviar");
  for (const ag of r.respondents ?? []) {
    void askAgent({
      data: {
        slug,
        parentId: ag.parent,
        fleetThread: ag.fleetThread,
        body,
        sender: "",
        handle: ag.handle,
        shellId: ag.shellId || undefined,
        invokerMessageId: r.id,
      },
    }).catch(() => {});
  }
  return { threadUrl: `/c/${slug}?thread=${r.id}` };
}
