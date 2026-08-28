// Un turno que MUERE no puede cerrarse como si hubiera entregado.
//
// Medido en descti el 2026-08-28: 4 turnos de 67 murieron por transporte (`terminated`,
// `fleet-stream 502`, el proceso caído) y se cobraron enteros — **705,399 facturables, el
// 17% del gasto del mes**, sin entregar nada. La causa era que el `catch` de
// `callAgentBackendStream` devolvía el aviso de error COMO SI FUERA la respuesta del
// agente, así que `finishTurn` lo cerraba en `done` y el medidor lo contaba como entrega.
//
// Estos invariantes se comprueban sobre el TEXTO de los módulos a propósito: son
// estructurales (¿existe el catch?, ¿se re-lanza?), no de comportamiento, y montar el
// stream del worker para probarlos costaría más de lo que protege.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const raiz = join(import.meta.dirname, "..");
const leer = (p: string) => readFileSync(join(raiz, p), "utf8");

describe("un turno muerto se marca como fallido", () => {
  it("cada aviso de «No pude contactar» avisa antes por onFailure", () => {
    const src = leer("agents.server.ts");
    // Cada `return`/`await onChunk` del aviso tiene que ir precedido de la señal. Se cuenta
    // en vez de mirar uno: hay CINCO caminos (streaming, webhook, ACP, A2A y fleet
    // bloqueante) y arreglar sólo el primero deja el 75% del problema en pie.
    const avisos = src.match(/No pude contactar a @\$\{agent\.handle\}/g) ?? [];
    const señales = src.match(/onFailure\?\.\(\{ message:/g) ?? [];
    expect(avisos.length).toBeGreaterThanOrEqual(5);
    expect(señales.length).toBe(avisos.length);
  });

  it("chat.ts y dm.ts marcan el outcome del turno fallido", () => {
    for (const f of ["server/chat.ts", "server/dm.ts"]) {
      expect(leer(f), f).toMatch(/turnResult\.failure.*setTurnOutcome/s);
    }
  });
});

describe("un turno que revienta no se lleva por delante al proceso", () => {
  it("dm.ts captura el rechazo de runAgentTurn, como el room", () => {
    // Sin este `.catch`, un turno de DM que rechaza llegaba a `unhandledRejection` — que
    // re-lanzaba y MATABA el proceso, huerfanando los turnos de todos los tenants. El
    // turno perdido del 24-ago (Ley de Obras, 173,590 facturables) era un DM.
    const dm = leer("server/dm.ts");
    expect(dm).toMatch(/\}\)\.catch\(\(e\) => \{/);
    expect(dm).toMatch(/\}\)\.catch[\s\S]{0,900}?\}\)\.finally\(/);
  });

  it("unhandledRejection NUNCA re-lanza", () => {
    // Re-lanzar aquí mata un proceso que sirve a TODOS los tenants: una promesa suelta de
    // un workspace tiraba el trabajo en vuelo de los demás. Se registra y se sigue.
    const sd = leer("server/shutdown.server.ts");
    const handler = sd.slice(sd.indexOf('process.on("unhandledRejection"'));
    expect(handler).not.toMatch(/throw razon/);
    expect(handler).toMatch(/\[unhandled\]/);
  });
});

describe("retomar un turno muerto", () => {
  it("las columnas de reanudación se añaden por addColumn, nunca en el CREATE TABLE", () => {
    // ⚠️ Meterlas dentro del `CREATE TABLE IF NOT EXISTS` es la firma exacta del incidente
    // del 2026-07-29: los tenants que ya tienen la tabla NO la recrean, así que la columna
    // no aparece nunca y falla en silencio sólo para ellos.
    const src = readFileSync(join(raiz, "server/schema.server.ts"), "utf8");
    const crear = src.slice(src.indexOf("CREATE TABLE IF NOT EXISTS gt_turns"));
    const cuerpo = crear.slice(0, crear.indexOf(")`"));
    for (const col of ["body", "dm_id", "slug", "attachments", "shell_id", "tools_json", "reintento_de"]) {
      expect(cuerpo, `${col} no puede estar en el CREATE TABLE`).not.toContain(col);
      expect(src).toContain(`addColumn("gt_turns", "${col}"`);
    }
  });

  it("no sabemos qué tools corrieron ⇒ se trata como sucio, no como limpio", async () => {
    // `tools_json` NULL sólo pasa cuando el PROCESO murió antes de anotarlo — justo el caso
    // en que más pudo haberse ejecutado algo irreversible. Leerlo como "no corrió nada"
    // ofrecería el reintento sin aviso precisamente ahí.
    const src = readFileSync(join(raiz, "server/turns.server.ts"), "utf8");
    expect(src).toMatch(/toolsDesconocidas\s*=\s*f\.tools_json\s*==\s*null/);
    expect(readFileSync(join(raiz, "server/chat.ts"), "utf8")).toMatch(
      /t\.sucias\.length > 0 \|\| t\.toolsDesconocidas/
    );
  });

  it("el texto de continuación enumera hechos y prohíbe empezar de cero", async () => {
    const { textoDeContinuacion } = await import("./turns.server");
    const base = {
      messageId: 1, groupId: "g", invokerSub: null, channelId: 1, parentId: null, dmId: null,
      slug: "s", shellId: 1, agent: "ghosty", body: "analiza el documento", attachments: [],
      sucias: [], error: null,
    };
    const conTools = textoDeContinuacion({ ...base, tools: ["Bash", "Read"], toolsDesconocidas: false });
    expect(conTools).toContain("Bash, Read");
    expect(conTools).toContain("analiza el documento");
    expect(conTools).toMatch(/No vuelvas a empezar/);
    // Sin registro NO se afirma que no hizo nada: se le manda a mirar su propio historial.
    const sinRegistro = textoDeContinuacion({ ...base, tools: [], toolsDesconocidas: true });
    expect(sinRegistro).not.toMatch(/No alcanzaste a ejecutar ninguna/);
    expect(sinRegistro).toMatch(/REVISA tu propio historial/);
  });
});

describe("no se arrancan turnos mientras se despliega", () => {
  it("los dos caminos consultan seEstaApagando antes de trabajar", () => {
    // Un turno que nace durante el drenaje se cobra entero y no llega a entregar: systemd
    // mata el proceso a los ~90 s. El aviso va al CUERPO porque el SIGTERM ya cerró los SSE.
    for (const f of ["server/chat.ts", "server/dm.ts"]) {
      const src = readFileSync(join(raiz, f), "utf8");
      expect(src, f).toMatch(/seEstaApagando\(\)/);
      expect(src, f).toMatch(/seEstaApagando\(\)\)[\s\S]{0,400}?setMessageBody/);
    }
  });
});

describe("el botón de retomar", () => {
  it("reconoce las TRES formas en que la plataforma mata un turno", async () => {
    // Son tres emisores distintos: el catch del turno (`terminated`/502) y el barrido de
    // huérfanos, que escribe un texto si la burbuja tenía algo y otro si estaba vacía.
    // Cubrir sólo uno deja el botón invisible en dos tercios de los casos.
    const { turnoSeMurio } = await import("../components/chat/message");
    expect(turnoSeMurio("⚠️ No pude contactar a @ghosty: terminated")).toBe(true);
    expect(turnoSeMurio("medio documento\n\n⏹ _Interrumpido: el servidor se reinició mientras el agente escribía._")).toBe(true);
    expect(turnoSeMurio("⏹ Detenido (el servidor se reinició).")).toBe(true);
    // Lo que NO es una muerte de la plataforma: el botón Detener del usuario, y una
    // respuesta normal que casualmente hable de fallos.
    expect(turnoSeMurio("⏹ Detenido.")).toBe(false);
    expect(turnoSeMurio("El servidor de tu proveedor devolvió un error 502, revisa…")).toBe(false);
    expect(turnoSeMurio("")).toBe(false);
    expect(turnoSeMurio(null)).toBe(false);
  });
});
