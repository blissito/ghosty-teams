// Cliente ACP contra un relé falso: sin caja, sin agente, sin modelo.
//
// Lo que importa probar aquí no es el feliz camino del texto —eso lo hace cualquier cliente—
// sino lo que distingue a ACP: que el agente puede llamarnos a NOSOTROS y quedarse detenido
// hasta que contestemos.
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";

import { acpTicketUrl, runAcpTurn } from "./acp-client.server";

let wss: WebSocketServer;
let url = "";
/** Lo que el relé falso debe hacer en el próximo turno. */
let guion: (ws: WS, m: any) => void = () => {};
let ultimaUrl = "";
let ultimosHeaders: Record<string, string | undefined> = {};
/** Un agente que valida SUS sessionId rechaza los ajenos. goose no lo hacía. */
let cargaFalla = false;
let ultimoPrompt: { type: string; text: string }[] = [];
/** Lo que el agente re-emite al cargar la sesión (el replay que exige la spec). */
let replay: string[] = [];
/** Lo que el agente declara en `initialize`. Un agente sin visión NO recibe imágenes inline. */
let declaraImagen = false;
/** ¿Sabe retomar una sesión? GhostyCode 0.0.19 dice que NO, y aun así recuerda dentro de la suya. */
let declaraLoadSession = true;
/** Métodos que el agente recibió, en orden. Es lo que prueba que NO abrimos sesión de más. */
let metodos: string[] = [];
/** Lo que el agente declara en `session/new` además del id: `models`/`modes` o `configOptions`. */
let sesionExtra: Record<string, unknown> = {};
/** Si está puesto, el agente RECHAZA ese método con un error. */
let rechazaMetodo = "";
/** Cuántas conexiones seguidas debe rechazar el relé antes de atender. */
let rechazosPendientes = 0;
/** Con qué código rechaza. -32000 = cupo lleno (transitorio); otro = definitivo. */
let codigoRechazo = -32000;
/** Cuántas veces se ha conectado el cliente. Es lo que prueba que hubo reintento. */
let conexiones = 0;

const env = (o: any, extra: any) => JSON.stringify({ jsonrpc: "2.0", ...o, ...extra }) + "\n";

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acp`;
  wss.on("connection", (ws, req) => {
    ultimaUrl = req.url ?? "";
    ultimosHeaders = req.headers as Record<string, string | undefined>;
    conexiones++;
    // El relé de verdad rechaza en el `attach`: manda un error SIN `id` (no contesta a nada
    // nuestro) y cierra. Es el frame que el cliente descartaba en silencio.
    if (rechazosPendientes > 0) {
      rechazosPendientes--;
      ws.send(
        env({ id: null }, {
          error: {
          code: codigoRechazo,
          message:
            codigoRechazo === -32000
              ? "esta caja ya atiende 4 conversaciones a la vez (tope 4); inténtalo en un momento"
              : "no pude arrancar la sesión del agente",
        },
        }),
      );
      ws.close();
      return;
    }
    ws.on("message", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.method) metodos.push(m.method);
        if (m.method === "initialize")
          ws.send(
            env({ id: m.id }, {
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: declaraLoadSession, promptCapabilities: { image: declaraImagen } },
              },
            }),
          );
        else if (m.method === "session/new") ws.send(env({ id: m.id }, { result: { sessionId: "ses-1", ...sesionExtra } }));
        else if (m.method === "session/load") {
          if (cargaFalla) {
            ws.send(env({ id: m.id }, { error: { code: -32602, message: "sesión desconocida" } }));
          } else {
            // La spec obliga: al cargar, el agente REPLICA la conversación entera antes de
            // contestar. Este agente falso lo hace, que es lo que hace goose de verdad.
            for (const viejo of replay) {
              ws.send(
                env({}, {
                  method: "session/update",
                  params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: viejo } } },
                }),
              );
            }
            ws.send(env({ id: m.id }, { result: {} }));
          }
        }
        else if (m.method === "session/prompt") {
          ultimoPrompt = m.params?.prompt ?? [];
          guion(ws, m);
        }
        else if (rechazaMetodo && m.method === rechazaMetodo)
          ws.send(env({ id: m.id }, { error: { code: -32602, message: "no puedo cambiar eso" } }));
        else if (m.id != null) ws.send(env({ id: m.id }, { result: {} }));
      }
    });
  });
});

afterAll(() => wss.close());

const turno = (over: Partial<Parameters<typeof runAcpTurn>[0]> = {}) => {
  const updates: any[] = [];
  return {
    updates,
    run: () =>
      runAcpTurn({
        wsUrl: url,
        workspaceNs: "acme",
        sub: "user-1",
        text: "hola",
        onUpdate: (u) => void updates.push(u),
        // Los de producción son segundos: un caso que los agota tarda más que el timeout
        // del runner. Lo que se prueba aquí es la LÓGICA del reintento, no su reloj.
        reintentosMs: [5, 5],
        ...over,
      }),
  };
};

describe("el turno", () => {
  it("acumula el texto y devuelve la sesión", async () => {
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hola " } } } }));
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mundo" } } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    const r = await t.run();
    expect(r.text).toBe("hola mundo");
    expect(r.sessionId).toBe("ses-1");
    expect(r.stopReason).toBe("end_turn");
  });

  it("el razonamiento NO entra en el texto de la respuesta", async () => {
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "mmm…" } } } }));
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "listo" } } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    const r = await t.run();
    expect(r.text).toBe("listo"); // el pensamiento es contexto, no contenido
    expect(t.updates.map((u) => u.kind)).toEqual(["thought", "text"]);
  });

  it("un update desconocido se reporta en vez de tirarse en silencio", async () => {
    // ACP sigue creciendo (v2 está en RFD): saber que llegó algo nuevo vale más que fingir
    // que no existe.
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "cosa_del_futuro" } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    await t.run();
    expect(t.updates).toEqual([{ kind: "otro", tipo: "cosa_del_futuro" }]);
  });

  it("traduce tool_call y plan al vocabulario del chat", async () => {
    guion = (ws, m) => {
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "leer main.rs", status: "in_progress" } } }));
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "plan", entries: [{ content: "paso 1", status: "pending" }] } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    await t.run();
    expect(t.updates[0]).toEqual({ kind: "tool", id: "t1", title: "leer main.rs", status: "in_progress" });
    expect(t.updates[1]).toEqual({ kind: "plan", entries: [{ content: "paso 1", status: "pending" }] });
  });

  // La secuencia REAL de una tool que pide permiso y acaba fallando. Es la que rompía el
  // checklist: la spec manda el título UNA VEZ, en el `tool_call`, y los updates posteriores
  // no lo repiten. Sin arrastrarlo, el fallo llegaba sin nombre, abría una segunda fila
  // llamada "herramienta" y le robaba el id — la herramienta de verdad se quedaba con su
  // palomita mientras el veredicto acababa en una fila anónima. Visto con @taller el
  // 2026-09-01: «2 herramientas · 1 falló» para UNA sola escritura que nunca ocurrió.
  it("el título se arrastra a los updates que no lo repiten", async () => {
    guion = (ws, m) => {
      const upd = (u: Record<string, unknown>) =>
        ws.send(env({}, { method: "session/update", params: { update: u } }));
      upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "apply patch: celebracion.txt", status: "pending" });
      upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
      upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    await t.run();
    const tools = t.updates.filter((u: any) => u.kind === "tool");
    expect(tools).toHaveLength(3);
    // Los tres hablan de la MISMA herramienta y los tres saben cómo se llama.
    expect(tools.map((u: any) => u.title)).toEqual([
      "apply patch: celebracion.txt",
      "apply patch: celebracion.txt",
      "apply patch: celebracion.txt",
    ]);
    expect(tools.map((u: any) => u.id)).toEqual(["t1", "t1", "t1"]);
    expect((tools[2] as any).status).toBe("failed");
  });

  it("cada tool recuerda SU título, no el del vecino", async () => {
    guion = (ws, m) => {
      const upd = (u: Record<string, unknown>) =>
        ws.send(env({}, { method: "session/update", params: { update: u } }));
      upd({ sessionUpdate: "tool_call", toolCallId: "a", title: "leer LEEME.txt", status: "pending" });
      upd({ sessionUpdate: "tool_call", toolCallId: "b", title: "escribir notas.md", status: "pending" });
      upd({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno();
    await t.run();
    const fin = t.updates.filter((u: any) => u.kind === "tool").at(-1) as any;
    expect(fin.title).toBe("leer LEEME.txt");
  });
});

describe("permisos — lo que distingue a ACP", () => {
  const pidePermiso = (ws: WS, m: any) => {
    ws.send(env({ id: 999 }, { method: "session/request_permission", params: { toolCall: { title: "¿Borro el archivo?" }, options: [{ optionId: "allow", name: "Sí" }, { optionId: "deny", name: "No" }] } }));
    // El agente NO sigue hasta que le contesten: el prompt se resuelve después.
    setTimeout(() => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } })), 60);
  };

  it("la pregunta llega con sus opciones y la respuesta elegida vuelve", async () => {
    guion = pidePermiso;
    let visto: any = null;
    const t = turno({
      onPermission: async (p) => {
        visto = p;
        return "allow";
      },
    });
    await t.run();
    expect(visto.title).toBe("¿Borro el archivo?");
    expect(visto.options).toEqual([
      { id: "allow", label: "Sí", kind: undefined },
      { id: "deny", label: "No", kind: undefined },
    ]);
  });

  it("🔴 sin manejador se RECHAZA, no se aprueba", async () => {
    // Un permiso que se concede solo porque nadie estaba mirando no es un permiso.
    guion = (ws, m) => {
      let respuesta: any = null;
      ws.on("message", (d) => {
        for (const l of d.toString().split("\n")) {
          if (!l.trim()) continue;
          const x = JSON.parse(l);
          if (x.id === 999 && x.result) respuesta = x.result;
        }
      });
      ws.send(env({ id: 999 }, { method: "session/request_permission", params: { toolCall: { title: "¿Borro?" }, options: [] } }));
      setTimeout(() => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn", eco: respuesta } })), 80);
    };
    const t = turno(); // sin onPermission
    const r = await t.run();
    expect((r as any).stopReason).toBe("end_turn");
  });

  it("una petición del agente que no soportamos se rechaza explícitamente", async () => {
    // Dejarla sin contestar dejaría al agente detenido para siempre.
    let respondio = false;
    guion = (ws, m) => {
      ws.on("message", (d) => {
        for (const l of d.toString().split("\n")) {
          if (!l.trim()) continue;
          const x = JSON.parse(l);
          if (x.id === 888 && x.error) respondio = true;
        }
      });
      ws.send(env({ id: 888 }, { method: "fs/read_text_file", params: { path: "/x" } }));
      setTimeout(() => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } })), 80);
    };
    await turno().run();
    expect(respondio).toBe(true);
  });
});

describe("🔴 el ticket lleva el tenant dentro de la firma", () => {
  it("firma ts.ns.sub y los manda en el query", () => {
    process.env.ACP_TICKET_SECRET = "secreto";
    const u = new URL(acpTicketUrl("wss://caja/acp", "acme", "user-1"));
    const ts = u.searchParams.get("ts")!;
    const esperado = crypto.createHmac("sha256", "secreto").update(`${ts}.acme.user-1`).digest("hex");
    expect(u.searchParams.get("sig")).toBe(esperado);
    expect(u.searchParams.get("ns")).toBe("acme");
    delete process.env.ACP_TICKET_SECRET;
  });

  it("sin secreto no inventa un ticket: la URL no adivinable es la capability", () => {
    delete process.env.ACP_TICKET_SECRET;
    expect(acpTicketUrl("wss://caja/acp", "acme", "u")).toBe("wss://caja/acp");
  });

  it("el ticket viaja de verdad en la conexión", async () => {
    process.env.ACP_TICKET_SECRET = "secreto";
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno().run();
    expect(ultimaUrl).toContain("ns=acme");
    expect(ultimaUrl).toContain("sig=");
    delete process.env.ACP_TICKET_SECRET;
  });
});

/**
 * Los dos silencios. Un turno colgado no es un error del protocolo —es lo que el usuario ve:
 * una burbuja vacía girando para siempre. Pasó el 19 ago 2026 con una caja borrada cuya URL
 * seguía viva en el router: el WS abría, el prompt salía, y nadie contestaba jamás.
 */
describe("cuando el agente se calla", () => {
  it("falla si el socket muere a media respuesta, en vez de esperar para siempre", async () => {
    guion = (ws) => ws.close();
    await expect(turno().run()).rejects.toThrow(/cerró la conexión/);
  });

  it("falla por SILENCIO, y el reloj no corre mientras un humano decide un permiso", async () => {
    // El relé pide permiso y se calla. Quien contesta tarda MÁS que el `idleMs`: el turno
    // debe sobrevivir esa espera —es un humano— y morir sólo por el silencio de después.
    guion = (ws, m) => {
      ws.send(
        env({ id: 99 }, { method: "session/request_permission", params: { title: "¿sigo?", options: [{ optionId: "ok", name: "Sí" }] } }),
      );
      void m;
    };
    const t = turno({
      idleMs: 300,
      onPermission: async () => {
        await new Promise((r) => setTimeout(r, 900));
        return "ok";
      },
    });
    const t0 = Date.now();
    await expect(t.run()).rejects.toThrow(/sin responder/);
    // Si el permiso no hubiera pausado el reloj, habría muerto a los ~300ms.
    expect(Date.now() - t0).toBeGreaterThan(900);
  });
});

/**
 * El token de las tools del espacio viaja en el HANDSHAKE, no en la URL.
 *
 * Es una credencial de verdad —con ella se ejercen las herramientas de una persona— y las
 * URIs acaban en los access logs de cualquier proxy del camino. El ticket sí va en la URL,
 * pero por una limitación que aquí no aplica (un WebSocket de navegador no puede poner
 * headers) y porque no sirve fuera de su caja.
 */
describe("el token de tools", () => {
  it("va en un header y NO ensucia la URL", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({ toolToken: "tok-capacidad-abc" }).run();
    expect(ultimosHeaders["x-ghosty-tools"]).toBe("tok-capacidad-abc");
    expect(ultimaUrl).not.toContain("tok-capacidad-abc");
  });

  it("sin token no se manda el header: un turno sin tools no aparenta tenerlas", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno().run();
    expect(ultimosHeaders["x-ghosty-tools"]).toBeUndefined();
  });
});

/**
 * Que esto funcione con OTROS agentes ACP, no sólo con goose.
 *
 * goose acepta el `sessionId` que le mandemos, así que durante meses tapó una suposición
 * nuestra. Un agente que valida los suyos —lo que dice la spec: el id lo genera él— devuelve
 * error, y el turno tiene que salir adelante igual.
 */
describe("un agente que no es goose", () => {
  it("rechaza un sessionId ajeno y el turno sigue: se abre una sesión nueva", async () => {
    cargaFalla = true;
    guion = (ws, m) => {
      ws.send(
        env({}, {
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "listo" } } },
        }),
      );
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const r = await turno({ sessionId: "un-id-que-inventamos-nosotros" }).run();
    cargaFalla = false;
    // Ni excepción ni turno vacío: el cliente cayó a `session/new` y devolvió el id DEL AGENTE.
    expect(r.text).toBe("listo");
    expect(r.sessionId).toBe("ses-1");
  });
});

/**
 * El turno va en BLOQUES, no en un texto pegado.
 *
 * El 2026-07-12 la persona del agente se metió dentro del mensaje del usuario y el modelo la
 * leyó como intento de inyección — con razón: desde su punto de vista era el usuario dándole
 * órdenes. El camino nativo lo arregló con una capa system que ACP no tiene; aquí se arregla
 * diciendo QUIÉN HABLA en cada bloque.
 */
describe("los bloques del turno", () => {
  const soloTexto = () => ultimoPrompt.map((b) => b.text);

  it("persona, contexto y mensaje van separados y EN ESE ORDEN", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({ persona: "Eres seco y directo", context: "Repos del room: acme/web" }).run();
    const [persona, ctx, msg] = soloTexto();
    expect(persona).toContain("Eres seco y directo");
    expect(ctx).toContain("acme/web");
    // El mensaje va SOLO, al final: es lo único que escribió una persona.
    expect(msg).toBe("hola");
    expect(ultimoPrompt).toHaveLength(3);
  });

  it("el bloque de contexto dice de dónde viene y que no se negocia", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({ context: "Repos del room: acme/web" }).run();
    const ctx = soloTexto()[0];
    expect(ctx).toMatch(/plataforma/i);
    expect(ctx).toMatch(/no son instrucciones de nadie del chat/i);
    // Y no arrastra el mensaje del usuario: si lo llevara dentro, volveríamos al problema.
    expect(ctx).not.toContain("hola");
  });

  it("sin persona ni contexto se manda un solo bloque, como siempre", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno().run();
    expect(ultimoPrompt).toEqual([{ type: "text", text: "hola" }]);
  });
});

/**
 * El REPLAY de `session/load` no es la respuesta de este turno.
 *
 * La spec es literal: *"the Agent MUST replay the entire conversation to the Client in the
 * form of session/update notifications"*. Acumularlo pegaba la conversación entera delante de
 * cada respuesta — en el chat se veía como si un hilo viejo, incluso uno ya BORRADO, volviera
 * solo y amontonado. Lo reportó el usuario el 19 ago 2026 con una captura de dos turnos
 * concatenados sin ni un salto de línea entre medias.
 */
describe("al retomar una sesión", () => {
  it("🔴 lo que se replica NO entra en la respuesta del turno", async () => {
    replay = ["Análisis del PR #149 de ayer", "…y su conclusión"];
    guion = (ws, m) => {
      ws.send(
        env({}, {
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "issue creado" } } },
        }),
      );
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const t = turno({ sessionId: "ses-1" });
    const r = await t.run();
    replay = [];
    expect(r.text).toBe("issue creado");
    expect(r.text).not.toContain("#149");
    // Y tampoco se pinta: lo que llega en el replay no debe llamar a `onUpdate`, o el chat
    // lo streamea como si el agente lo estuviera diciendo ahora.
    expect(t.updates.filter((u) => u.kind === "text").map((u) => u.text)).toEqual(["issue creado"]);
  });

  it("si la carga falla a mitad del replay, el turno NO se queda mudo", async () => {
    // La bandera se limpia en un `finally`: un turno mudo es peor que uno repetido, porque
    // no deja ni rastro de qué pasó.
    replay = ["algo viejo"];
    cargaFalla = true;
    guion = (ws, m) => {
      ws.send(
        env({}, {
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "respuesta nueva" } } },
        }),
      );
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const r = await turno({ sessionId: "ses-vieja" }).run();
    cargaFalla = false;
    replay = [];
    expect(r.text).toBe("respuesta nueva");
  });
});


// ADJUNTOS (2026-08-19). Antes de esto `runAcpTurn` no recibía `parts`: subirle un PDF a un
// agente ACP no fallaba, simplemente NO LLEGABA — y el agente contestaba que no había recibido
// nada, que desde fuera se lee como que el producto perdió el archivo.
describe("adjuntos", () => {
  const soloTexto = () => ultimoPrompt.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

  beforeEach(() => {
    declaraImagen = false;
  });

  it("una imagen va INLINE si el agente declara que las ve", async () => {
    declaraImagen = true;
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({
      parts: [{ kind: "file", file: { name: "logo.png", mimeType: "image/png", bytes: "AAAA" } }],
    }).run();
    const img: any = ultimoPrompt.find((b: any) => b.type === "image");
    expect(img).toBeTruthy();
    expect(img.data).toBe("AAAA");
    expect(img.mimeType).toBe("image/png");
  });

  // 🔴 Mandarle una imagen inline a un agente que no las declara la rechaza con error de
  // protocolo y tumba el TURNO ENTERO: no degrada. Por eso se pregunta en vez de suponer.
  it("un agente SIN visión no recibe la imagen inline, recibe el enlace", async () => {
    declaraImagen = false;
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({
      parts: [
        { kind: "file", file: { name: "logo.png", mimeType: "image/png", bytes: "AAAA", uri: "https://x/logo.png" } },
      ],
    }).run();
    expect(ultimoPrompt.find((b: any) => b.type === "image")).toBeUndefined();
    expect(ultimoPrompt.find((b: any) => b.type === "resource_link")).toBeTruthy();
  });

  it("un PDF viaja como enlace firmado, nunca en base64", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({
      parts: [
        { kind: "file", file: { name: "escritura.pdf", mimeType: "application/pdf", uri: "https://x/e.pdf" } },
      ],
    }).run();
    const link: any = ultimoPrompt.find((b: any) => b.type === "resource_link");
    expect(link.uri).toBe("https://x/e.pdf");
    expect(link.name).toBe("escritura.pdf");
  });

  // Un `resource_link` suelto es fácil de ignorar; nombrarlos en texto es lo que hace que el
  // agente sepa que tiene material que abrir.
  it("los adjuntos se NOMBRAN además en un bloque de texto", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({
      parts: [{ kind: "file", file: { name: "escritura.pdf", mimeType: "application/pdf", uri: "https://x/e.pdf" } }],
    }).run();
    expect(soloTexto()).toContain("escritura.pdf");
    expect(soloTexto()).toContain("ADJUNTOS DE ESTE MENSAJE");
  });

  it("un adjunto que no se puede entregar se DICE, no se pierde en silencio", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({
      parts: [{ kind: "file", file: { name: "roto.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }],
    }).run();
    expect(soloTexto()).toContain("roto.docx");
    expect(ultimoPrompt.find((b: any) => b.type === "resource_link")).toBeUndefined();
  });

  it("el mensaje de la persona sigue siendo el ÚLTIMO bloque", async () => {
    // Los adjuntos son material; las instrucciones las da quien escribe, y van al final para
    // que el modelo no lea el material como si le diera órdenes.
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno({
      text: "resúmelo",
      parts: [{ kind: "file", file: { name: "a.pdf", mimeType: "application/pdf", uri: "https://x/a.pdf" } }],
    }).run();
    expect((ultimoPrompt[ultimoPrompt.length - 1] as any).text).toBe("resúmelo");
  });

  it("sin adjuntos no aparece ningún bloque de adjuntos", async () => {
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    await turno().run();
    expect(soloTexto()).not.toContain("ADJUNTOS");
  });
});


describe("🔴 cupo lleno: el relé DICE por qué, y se reintenta", () => {
  beforeEach(() => {
    rechazosPendientes = 0;
    conexiones = 0;
    codigoRechazo = -32000;
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
  });

  it("el mensaje del relé llega al llamador en vez del genérico de socket cerrado", async () => {
    // Más rechazos que reintentos: se agotan y el error tiene que salir.
    rechazosPendientes = 99;
    // ⚠️ Lo que fallaba: el frame va sin `id`, así que no respondía a ninguna promesa
    // pendiente y se tiraba; el `close` de después ganaba la carrera y el usuario leía «el
    // agente cerró la conexión a media respuesta» — indistinguible de una caja caída.
    await expect(turno().run()).rejects.toThrow(/ya atiende 4 conversaciones/);
    await expect(turno().run()).rejects.not.toThrow(/cerró la conexión/);
  });

  it("un rechazo pasajero se reintenta y el turno SALE", async () => {
    rechazosPendientes = 1;
    const t = turno();
    const r = await t.run();
    expect(r.stopReason).toBe("end_turn");
    // Dos conexiones: la rechazada y la buena. Es lo único que prueba que hubo reintento.
    expect(conexiones).toBe(2);
  });

  it("deja de reintentar y se rinde con el motivo a la vista", async () => {
    rechazosPendientes = 99;
    await expect(turno().run()).rejects.toThrow(/ya atiende/);
    // Un intento + los dos reintentos, y ni uno más: reintentar sin fin dejaría al usuario
    // mirando una burbuja girando mientras la caja sigue llena.
    expect(conexiones).toBe(3);
  });

  it("un error que NO es de cupo se entrega A LA PRIMERA", async () => {
    // El fallo de arranque de la sesión (-32603) no se despeja solo: reintentarlo sólo
    // retrasaría la mala noticia. Y su mensaje también se estaba perdiendo.
    codigoRechazo = -32603;
    rechazosPendientes = 99;
    await expect(turno().run()).rejects.toThrow(/no pude arrancar la sesión/);
    expect(conexiones).toBe(1);
  });
});


// ── La sesión: NO se abre una nueva por turno ────────────────────────────────────
//
// La amnesia de @taller, 2026-09-01. Se llamaba a `session/load` SIEMPRE que hubiera
// `sessionId`; GhostyCode 0.0.19 declara `loadSession:false`, contestaba error, y el catch
// concluía "no se puede continuar" y abría sesión nueva — cada turno. Su sesión seguía viva
// en su proceso y la tirábamos nosotros, así que el agente no recordaba lo que acababa de
// hacer y de paso se churneaba contra su tope de sesiones.
//
// `session/load` es para RESUCITAR una sesión que el agente ya no tiene, no un trámite
// previo a cada prompt.
describe("continuidad de la sesión", () => {
  beforeEach(() => {
    metodos = [];
    declaraLoadSession = true;
    cargaFalla = false;
    // ⚠️ Las fixtures son de MÓDULO y el `beforeEach` de cada suite corre antes de SUS tests,
    // no después: la suite de reintentos deja `rechazosPendientes` en 99 de su último caso y
    // el relé falso rechazaría todas las conexiones de aquí. Quien llega, limpia.
    rechazosPendientes = 0;
    codigoRechazo = -32000;
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
  });

  it("sin loadSession NO se pide load ni se abre sesión nueva: se promptea el id guardado", async () => {
    declaraLoadSession = false;
    const r = await turno({ sessionId: "ses-vieja" }).run();
    expect(metodos).not.toContain("session/load");
    expect(metodos).not.toContain("session/new");
    expect(r.sessionId).toBe("ses-vieja");
  });

  it("con loadSession sí se retoma, que es para lo que existe", async () => {
    const r = await turno({ sessionId: "ses-vieja" }).run();
    expect(metodos).toContain("session/load");
    expect(metodos).not.toContain("session/new");
    expect(r.sessionId).toBe("ses-vieja");
  });

  it("sin sesión previa se abre una, claro", async () => {
    declaraLoadSession = false;
    const r = await turno().run();
    expect(metodos).toContain("session/new");
    expect(r.sessionId).toBe("ses-1");
  });

  // Lo que el turno APRENDE, y que decide cuánto contexto se le manda al siguiente. No se
  // deduce de `loadSession`: un agente puede no saber retomar y aun así conservar su sesión
  // viva entre conexiones. Lo que importa es el hecho.
  it("sin sesión previa no se aprende nada: no había nada que retomar", async () => {
    const r = await turno().run();
    expect(r.retains).toBeUndefined();
  });

  it("si la sesión guardada SIRVIÓ, el agente retiene", async () => {
    declaraLoadSession = false;
    const r = await turno({ sessionId: "ses-vieja" }).run();
    expect(r.retains).toBe(true);
  });

  it("si NO sirvió, el agente no retiene y hay que compensarlo con contexto", async () => {
    declaraLoadSession = false;
    let primera = true;
    guion = (ws, m) => {
      if (primera) {
        primera = false;
        ws.send(env({ id: m.id }, { error: { code: -32602, message: "unknown sessionId" } }));
        return;
      }
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const r = await turno({ sessionId: "ses-muerta" }).run();
    expect(r.retains).toBe(false);
  });

  it("un session/load que falla también dice que no retiene", async () => {
    cargaFalla = true;
    const r = await turno({ sessionId: "ses-vieja" }).run();
    expect(r.retains).toBe(false);
  });

  it("si el id guardado ya no vale, se abre nueva y se reintenta UNA vez", async () => {
    declaraLoadSession = false;
    let primera = true;
    guion = (ws, m) => {
      if (primera) {
        // Lo que contesta un agente cuyo tope de sesiones expulsó la más vieja.
        primera = false;
        ws.send(env({ id: m.id }, { error: { code: -32602, message: "session not found" } }));
        return;
      }
      ws.send(env({}, { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
      ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
    };
    const r = await turno({ sessionId: "ses-caduca" }).run();
    expect(metodos.filter((x) => x === "session/prompt")).toHaveLength(2);
    expect(metodos).toContain("session/new");
    expect(r.text).toBe("ok");
    expect(r.sessionId).toBe("ses-1");
  });
});


// ── Aplicar el modelo/modo que eligió el dueño ──────────────────────────────────
//
// Probado antes contra las cajas vivas: `session/set_model {sessionId, modelId}` y
// `session/set_mode {sessionId, modeId}` contestan `{}`; goose usa
// `session/set_config_option {sessionId, configId, value}` y su respuesta trae la lista
// COMPLETA actualizada (cambiar de proveedor cambia los modelos disponibles).
describe("preferencias de ajustes", () => {
  beforeEach(() => {
    metodos = [];
    sesionExtra = {};
    rechazaMetodo = "";
    declaraLoadSession = true;
    cargaFalla = false;
    rechazosPendientes = 0;
    codigoRechazo = -32000;
    guion = (ws, m) => ws.send(env({ id: m.id }, { result: { stopReason: "end_turn" } }));
  });

  const conModelo = (current: string) => ({
    models: {
      currentModelId: current,
      availableModels: [{ modelId: "auto", name: "Auto" }, { modelId: "pro", name: "Pro" }],
    },
  });

  it("manda el cambio cuando difiere de lo que el agente declara", async () => {
    sesionExtra = conModelo("auto");
    const r = await turno({ prefs: { model: "pro" } }).run();
    expect(metodos).toContain("session/set_model");
    expect(r.settings?.find((x) => x.id === "model")?.current).toBe("pro");
  });

  it("NO manda nada si ya está en ese valor", async () => {
    sesionExtra = conModelo("pro");
    await turno({ prefs: { model: "pro" } }).run();
    expect(metodos).not.toContain("session/set_model");
  });

  it("ignora un valor que el agente ya no ofrece", async () => {
    sesionExtra = conModelo("auto");
    await turno({ prefs: { model: "un-modelo-que-ya-no-existe" } }).run();
    expect(metodos).not.toContain("session/set_model");
  });

  // Un select desactualizado no puede dejar sin respuesta a nadie: el ajuste se pierde, el
  // turno no.
  it("si el agente RECHAZA el ajuste, el turno sigue igual", async () => {
    sesionExtra = conModelo("auto");
    rechazaMetodo = "session/set_model";
    try {
      const r = await turno({ prefs: { model: "pro" } }).run();
      expect(metodos).toContain("session/set_model");
      expect(r.stopReason).toBe("end_turn");
      // Y no se miente sobre el estado: sigue declarando el que de verdad tiene.
      expect(r.settings?.find((x) => x.id === "model")?.current).toBe("auto");
    } finally {
      rechazaMetodo = "";
    }
  });

  it("sin preferencias no se toca nada", async () => {
    sesionExtra = conModelo("auto");
    await turno().run();
    expect(metodos.filter((x) => x.startsWith("session/set"))).toEqual([]);
  });
});
