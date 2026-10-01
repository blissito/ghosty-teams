// Un corte corto de infra (reinicio del daemon, gs drenando) no puede tirar el trabajo de un
// agente. Medido el 2026-10-01 en el hilo de MailMask: @plan murió por haber leído la
// conversación antes del corte (cualquier tool apagaba el reintento), @build quedó colgado
// con la burbuja vacía (el stream no tenía límite sin datos) y, como su turno nació de un
// despertador, ni el barrido ni «Retomar» lo veían.
//
// Mismo criterio que turno-muerto.test.ts: lo estructural se comprueba sobre el TEXTO del
// módulo; lo puro, con su función.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { isCleanTool } from "./turns.server";

const raiz = join(import.meta.dirname, "..");
const leer = (p: string) => readFileSync(join(raiz, p), "utf8");

describe("tools que se pueden repetir", () => {
  it("leer la conversación es limpio, con o sin prefijo MCP", () => {
    expect(isCleanTool("chat_history")).toBe(true);
    expect(isCleanTool("mcp__ghosty__chat_history")).toBe(true);
    expect(isCleanTool("Read")).toBe(true);
  });
  it("lo demás es sucio por default", () => {
    expect(isCleanTool("Bash")).toBe(false);
    expect(isCleanTool("chat_message")).toBe(false);
    expect(isCleanTool("mcp__ghosty__factory_plan_submit")).toBe(false);
    expect(isCleanTool(undefined)).toBe(false);
  });
});

describe("el stream de un turno aguanta un corte corto", () => {
  const src = leer("agents.server.ts");
  it("sólo una tool SUCIA apaga el reintento", () => {
    expect(src).toMatch(/if \(ev\.phase !== "end" && !isCleanTool\(ev\.name\)\) huboTool = true;/);
  });
  it("un stream sin datos se corta como `terminated` (cae en el reintento)", () => {
    expect(src).toMatch(/IDLE_MS = 90_000/);
    expect(src).toMatch(/Promise\.race\(\[\s*reader\.read\(\)/);
    expect(src).toMatch(/new Error\(`terminated \(sin datos/);
  });
});

describe("un turno de despertador es un turno como cualquier otro", () => {
  it("se registra en gt_turns y se cierra al terminar", () => {
    const src = leer("server/wakeups.server.ts");
    expect(src).toMatch(/turns\.registerTurn\(\{/);
    expect(src).toMatch(/onShell: register/);
    expect(src).toMatch(/turns\.finishTurn\(ns, registeredId\)/);
  });
  it("la fábrica repite el encargo UNA vez a los 60 s si se cayó el camino", () => {
    const src = leer("server/apps/factory-runs.server.ts");
    expect(src).toMatch(/No pude contactar a @\/\.test\(reply\) && !w\.key\.endsWith\(":retry"\)/);
    expect(src).toMatch(/dueAt: Math\.floor\(Date\.now\(\) \/ 1000\) \+ 60/);
  });
});

describe("el PR del hilo", () => {
  it("se lee de la tarjeta simple gt-gh (aviso «PR #44 abierto»)", async () => {
    const { prOfMessage } = await import("../lib/ebdoc");
    const body =
      '🟢 **PR #44 abierto** por @BrendaOrtega · `blissito/agenda`\n\n```gt-gh\n{"kind":"pr","repo":"blissito/agenda","ref":"44","title":"Parches de seguridad","url":"https://github.com/blissito/agenda/pull/44","state":"open","author":"BrendaOrtega"}\n```';
    expect(prOfMessage(body)).toEqual({ repo: "blissito/agenda", number: 44, title: "Parches de seguridad", author: "BrendaOrtega" });
    expect(prOfMessage("hola")).toBeNull();
  });
});

describe("un reinicio de Teams no mata los turnos durables", () => {
  it("el barrido de huérfanos ADOPTA el turno durable en vez de cerrarlo", () => {
    const src = leer("server/turns.server.ts");
    expect(src).toMatch(/RETURNING message_id, invoker_message_ids, agent_handle, durable_turn_id/);
    expect(src).toMatch(/adopt: \{ shellId: mid, turnId \}/);
    expect(src).toMatch(/!adoptados\.has\(n\)/);
  });
  it("el despertador adopta en la MISMA burbuja y se reengancha sin crear otro turno", () => {
    const w = leer("server/wakeups.server.ts");
    expect(w).toMatch(/durableResume: ref\.adopt\.turnId/);
    expect(w).toMatch(/shellId = ref\.adopt\.shellId/);
    const a = leer("agents.server.ts");
    expect(a).toMatch(/let durable: boolean \| null = durableOpts\?\.resumeTurnId \? true : null;/);
    expect(a).toMatch(/durableOpts\?\.onDurable\?\.\(durableTurnId\)/);
  });
});

describe("hallazgos de @check legibles", () => {
  it("una lista de objetos se vuelve markdown, no [object Object]", async () => {
    const { findingsText } = await import("./apps/factory-tools.server");
    const t = findingsText([{ file: "src/login.ts", line: 12, issue: "no valida el token", fix: "rechazar vacío" }, "falta prueba de whoami"]);
    expect(t).toBe("- `src/login.ts:12` — no valida el token (arreglo: rechazar vacío)\n- falta prueba de whoami");
    expect(findingsText("  texto  ")).toBe("texto");
    expect(t).not.toMatch(/object Object/);
  });
});
