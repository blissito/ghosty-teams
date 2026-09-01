// Contestar una pregunta del agente.
//
// A diferencia del resto de las tarjetas del chat, aquí hay un turno DETENIDO al otro lado:
// el agente bloqueó su ejecución esperando una respuesta. Por eso contestar no es "mandar un
// mensaje": es CONTINUAR esa tarea con su `taskId`, que es lo que la desbloquea.
//
// Esto es SÓLO A2A. El `session/request_permission` de ACP se parece en pantalla pero no
// comparte lógica —allá el turno sigue corriendo y contestar sólo desbloquea una promesa, no
// lanza nada— y vive en `agent-permission.ts`.

import { createServerFn } from "@tanstack/react-start";

import { sessionUser } from "./chat";
import { resolvedAgents } from "../agents.server";
import type { ResolvedAgent } from "../agents.server";

export const answerAgentAskFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      /** El agente al que se le contesta (su @handle en este espacio). */
      handle: string;
      /** La tarea detenida. Sin esto no hay a quién desbloquear. */
      taskId: string;
      /** La conversación, para que el turno siga donde estaba. */
      groupId: string;
      /** Lo que se contesta: el `id` de la opción elegida, o texto libre. */
      answer: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    // Quien contesta tiene que estar en el espacio: un botón en un hilo no puede ser una
    // puerta abierta para desbloquear turnos ajenos.
    const user = await sessionUser();
    if (!user) throw new Error("sesión requerida");

    const agents = await resolvedAgents();
    const agent = agents.find((a: ResolvedAgent) => a.handle === data.handle);
    if (!agent) throw new Error(`@${data.handle} no está conectado`);
    if (agent.backend.kind !== "a2a") {
      // Los runtimes propios no tienen (todavía) un turno que se pueda detener y reanudar por
      // id: su equivalente es el STEER, que entra al turno vivo. Decirlo es mejor que fingir.
      throw new Error("este agente no soporta preguntas con respuesta diferida");
    }

    const { runA2ATurn } = await import("./a2a-client.server");
    const { currentNamespace } = await import("./tenant.server");

    let texto = "";
    await runA2ATurn({
      cardUrl: agent.backend.runtimeUrl,
      contextId: data.groupId,
      // El `taskId` es lo que convierte esto en "continúa aquella tarea" y no en "empieza una
      // nueva". Es el mismo mecanismo que A2A usa para el STEER.
      taskId: data.taskId,
      text: data.answer,
      workspaceNs: await currentNamespace(),
      onChunk: (c) => {
        texto += c;
      },
    });

    return { ok: true as const, reply: texto };
  });

/**
 * Comprueba que un agente ACP esté vivo, DESDE EL SERVIDOR, con el handshake del protocolo.
 *
 * Hacerlo desde el navegador no funciona: la caja no manda cabeceras CORS, así que el fetch
 * falla antes de leer nada y el usuario ve un botón que se queda pensando. Y aunque las
 * mandara, el navegador tampoco alcanza una caja que no esté expuesta al público — el
 * servidor sí.
 *
 * ⚠️ Antes esto pegaba a `/busy`, que NO es del protocolo, y por eso un agente que no fuera
 * nuestro relé (GhostyCode, Zed, uno de un tercero) fallaba con «la caja respondió 404»
 * teniendo el WebSocket sano. Ver `acpHandshake`.
 */
export const probeAcpBoxFn = createServerFn({ method: "POST" })
  .validator((d: { wsUrl: string; token?: string }) => d)
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user) throw new Error("sesión requerida");

    const raw = normalizeWsUrl(data.wsUrl);
    const { acpHandshake, acpBusy } = await import("./acp-client.server");
    const { currentNamespace } = await import("./tenant.server");
    const ns = await currentNamespace();
    const hs = await acpHandshake({ wsUrl: raw, ns, sub: user.sub, token: data.token?.trim() || undefined }).catch((e) => {
      throw new Error(`no responde: ${e instanceof Error ? e.message : e}`);
    });
    // Dato extra, nunca requisito: un 404 aquí sólo dice que no es nuestro relé.
    const busy = await acpBusy(raw);
    // Se aplana a primitivos a propósito: lo que cruza a la UI son DATOS, no el objeto
    // crudo del agente (que no es serializable ni tiene forma garantizada).
    const caps = hs.agentCapabilities as any;
    return {
      ok: true as const,
      agentName: hs.agentName ?? null,
      agentVersion: hs.agentVersion ?? null,
      protocolVersion: hs.protocolVersion ?? null,
      loadSession: caps?.loadSession === true,
      image: caps?.promptCapabilities?.image === true,
      busySessions: busy ? busy.sessions : null,
      // Que el agente salude no significa que pueda trabajar: si declara `authMethods` es que
      // le falta credencial de su proveedor y el primer turno va a fallar. Se avisa AQUÍ, que
      // es cuando la persona tiene su caja delante — no tres días después en un canal.
      needsAuth: (hs.authMethods ?? []).map((m) => m.name || m.id || "").filter(Boolean),
    };
  });

/**
 * Valida y normaliza la URL de un agente ACP. Vive aquí porque el probe y el alta tienen que
 * exigir lo MISMO: dos criterios distintos para la misma pregunta es exactamente lo que hacía
 * que «Probar» fallara y «Guardar» funcionara (o al revés), que es lo que confunde al usuario.
 */
export function normalizeWsUrl(raw: string): string {
  const v = (raw ?? "").trim();
  if (!v) throw new Error("URL del agente requerida");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("URL inválida");
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") {
    throw new Error("tiene que ser una URL de WebSocket (wss://…)");
  }
  return v;
}
