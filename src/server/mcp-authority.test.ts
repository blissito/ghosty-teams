// La autoridad del servidor MCP: a nombre de quién ejerce las tools un agente de fuera.
//
// ⚠️ Esto es la frontera de seguridad de la feature, no un detalle. El ticket de la URL sólo
// dice QUÉ conversación es; si `inflightAuthority` se equivoca, un agente ejerce los
// conectores personales de alguien que no se lo pidió.
import { describe, expect, it } from "vitest";

// Se baja ANTES de importar el módulo: la constante se lee al cargarlo. Con los 10s de
// producción, el caso de dos turnos solapados tardaría eso en producirse.
process.env.GROUP_LOCK_TIMEOUT_MS = "40";
const { inflightAuthority, registerTurn, finishTurn, withGroupLock, stopTurn } = await import("./turns.server");

/** Un grupo por caso: los locks se encadenan por groupId y contaminarían el siguiente. */
let n = 0;
const grupo = () => `g${++n}`;

const base = (messageId: number, invokerSub: string, groupId: string) => ({
  ns: "acme",
  messageId,
  groupId,
  invokerSub,
  controller: new AbortController(),
  dest: { channelId: 4, topic: "general" },
  scope: new Set(["lectura"]),
  publicChannel: false,
});

/** Deja el turno corriendo hasta que se resuelva la promesa que devuelve. */
function correr(messageId: number, groupId: string) {
  let soltar!: () => void;
  const espera = new Promise<void>((r) => (soltar = r));
  const dentro = withGroupLock(groupId, async () => espera, { ns: "acme", getId: () => messageId });
  return { soltar, dentro };
}
const respira = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("inflightAuthority", () => {
  it("sin turno en vuelo no hay autoridad", () => {
    expect(inflightAuthority(grupo())).toBeNull();
  });

  // Un turno registrado pero ESPERANDO su vuelta no está trabajando: su agente ni siquiera
  // recibió el prompt. Tratarlo como vivo daría autoridad a quien no la está ejerciendo.
  it("un turno en cola, sin ejecutar, tampoco", () => {
    const g = grupo();
    registerTurn(base(11, "s-ana", g) as never);
    expect(inflightAuthority(g)).toBeNull();
    finishTurn("acme", 11);
  });

  it("con uno ejecutando, devuelve SU invocador y su destino", async () => {
    const g = grupo();
    registerTurn(base(21, "s-ana", g) as never);
    const t = correr(21, g);
    await respira();
    const a = inflightAuthority(g)!;
    expect(a.invokerSub).toBe("s-ana");
    expect((a.dest as any).channelId).toBe(4);
    expect(a.publicChannel).toBe(false);
    t.soltar();
    await t.dentro;
    // Y al terminar deja de haberla: una tool llamada tarde no se ejerce a nombre de nadie.
    expect(inflightAuthority(g)).toBeNull();
    finishTurn("acme", 21);
  });

  // El lock se suelta a los 10s y ahí sí pueden solaparse dos. Elegir uno sería ejercer los
  // conectores de una persona a petición de otra.
  it("con DOS ejecutando a la vez, rechaza", async () => {
    const g = grupo();
    registerTurn(base(31, "s-ana", g) as never);
    registerTurn(base(32, "s-beto", g) as never);
    const a = correr(31, g);
    const b = correr(32, g); // espera el lock…
    await respira(80); // …y lo suelta al vencer el timeout: ahora hay DOS dentro
    expect(inflightAuthority(g)).toBeNull();
    a.soltar();
    b.soltar();
    await Promise.all([a.dentro, b.dentro]);
    finishTurn("acme", 31);
    finishTurn("acme", 32);
  });

  it("un turno detenido no da autoridad", async () => {
    const g = grupo();
    registerTurn(base(41, "s-ana", g) as never);
    const t = correr(41, g);
    await respira();
    stopTurn("acme", 41, "s-ana");
    expect(inflightAuthority(g)).toBeNull();
    t.soltar();
    await t.dentro;
    finishTurn("acme", 41);
  });

  it("otra conversación no ve la autoridad de ésta", async () => {
    const g = grupo();
    registerTurn(base(51, "s-ana", g) as never);
    const t = correr(51, g);
    await respira();
    expect(inflightAuthority("otro-grupo")).toBeNull();
    t.soltar();
    await t.dentro;
    finishTurn("acme", 51);
  });
});
