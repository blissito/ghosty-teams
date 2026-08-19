// Contestar una pregunta del agente.
//
// A diferencia del resto de las tarjetas del chat, aquí hay un turno DETENIDO al otro lado:
// el agente bloqueó su ejecución esperando una respuesta. Por eso contestar no es "mandar un
// mensaje": es CONTINUAR esa tarea con su `taskId`, que es lo que la desbloquea.
//
// Sirve para los dos protocolos. `TASK_STATE_INPUT_REQUIRED` de A2A y
// `session/request_permission` de ACP son el mismo gesto; sólo cambia por dónde viaja la
// respuesta, y eso lo resuelve el runtime del agente, no esta función.

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
      /** Por dónde viaja la respuesta. Ausente ⇒ `a2a`, como las tarjetas de hilos viejos. */
      kind?: "a2a" | "acp";
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
    const { currentNamespace } = await import("./tenant.server");

    // ── ACP: el turno NO terminó ────────────────────────────────────────────────
    //
    // Aquí no se lanza nada. Hay un turno corriendo con un WebSocket abierto y una petición
    // del agente sin contestar; lo único que hace falta es desbloquear la promesa que lo
    // tiene detenido. Lanzar un turno nuevo —como en A2A— sería pedirle al agente algo que
    // nadie pidió, además de dejar al primero colgado hasta que venza.
    if (data.kind === "acp" || agent.backend.kind === "acp") {
      const { resolverPermiso } = await import("./acp-permission.server");
      const ok = resolverPermiso(await currentNamespace(), data.taskId, data.answer || null);
      if (!ok) {
        // Contestada por alguien más, vencida, o el proceso se reinició y se llevó el
        // registro en memoria. Decirlo es mejor que fingir que el clic sirvió.
        throw new Error("esa pregunta ya no está esperando respuesta");
      }
      return { ok: true as const, reply: "" };
    }

    if (agent.backend.kind !== "a2a") {
      // Los runtimes propios no tienen (todavía) un turno que se pueda detener y reanudar por
      // id: su equivalente es el STEER, que entra al turno vivo. Decirlo es mejor que fingir.
      throw new Error("este agente no soporta preguntas con respuesta diferida");
    }

    const { runA2ATurn } = await import("./a2a-client.server");

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
 * Comprueba que una caja ACP esté viva, DESDE EL SERVIDOR.
 *
 * Hacerlo desde el navegador no funciona: la caja no manda cabeceras CORS, así que el fetch
 * falla antes de leer nada y el usuario ve un botón que se queda pensando. Y aunque las
 * mandara, el navegador tampoco alcanza una caja que no esté expuesta al público — el
 * servidor sí.
 */
export const probeAcpBoxFn = createServerFn({ method: "POST" })
  .validator((d: { wsUrl: string }) => d)
  .handler(async ({ data }) => {
    const user = await sessionUser();
    if (!user) throw new Error("sesión requerida");

    const raw = data.wsUrl.trim();
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("URL inválida");
    }
    if (u.protocol !== "wss:" && u.protocol !== "ws:") {
      throw new Error("tiene que ser una URL de WebSocket (wss://…)");
    }
    // `/busy` vive en el mismo host y puerto que el socket; sólo cambia el esquema.
    const health = new URL(raw.replace(/^ws/, "http"));
    health.pathname = "/busy";
    health.search = "";

    const res = await fetch(health.toString()).catch((e) => {
      throw new Error(`no responde: ${e instanceof Error ? e.message : e}`);
    });
    if (!res.ok) throw new Error(`la caja respondió ${res.status}`);
    const b = (await res.json()) as { busy?: boolean; sessions?: number };
    return { ok: true as const, busy: !!b.busy, sessions: b.sessions ?? 0 };
  });
