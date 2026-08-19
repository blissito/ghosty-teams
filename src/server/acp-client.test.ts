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

const env = (o: any, extra: any) => JSON.stringify({ jsonrpc: "2.0", ...o, ...extra }) + "\n";

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acp`;
  wss.on("connection", (ws, req) => {
    ultimaUrl = req.url ?? "";
    ultimosHeaders = req.headers as Record<string, string | undefined>;
    ws.on("message", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.method === "initialize")
          ws.send(
            env({ id: m.id }, {
              result: {
                protocolVersion: 1,
                agentCapabilities: { promptCapabilities: { image: declaraImagen } },
              },
            }),
          );
        else if (m.method === "session/new") ws.send(env({ id: m.id }, { result: { sessionId: "ses-1" } }));
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
