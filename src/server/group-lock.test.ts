import { describe, it, expect } from "vitest";
import { withGroupLock } from "./turns.server";

// El lock existe por una razón concreta: dos menciones simultáneas en el mismo room leían
// el artefacto CONCURRENTEMENTE y el segundo turno revertía la edición del primero al
// re-emitir una versión vieja. Lo que se prueba aquí es esa propiedad, no el lock en sí.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withGroupLock", () => {
  it("serializa el armado de dos turnos del mismo grupo", async () => {
    const orden: string[] = [];
    const turno = (nombre: string, dura: number) =>
      withGroupLock("g1", async () => {
        orden.push(`${nombre}:entra`);
        await sleep(dura);
        orden.push(`${nombre}:sale`);
      });

    await Promise.all([turno("a", 30), turno("b", 5)]);

    // Sin lock el orden sería a:entra, b:entra, b:sale, a:sale — que es exactamente el
    // entrelazado donde b lee el estado anterior a las escrituras de a.
    expect(orden).toEqual(["a:entra", "a:sale", "b:entra", "b:sale"]);
  });

  it("no serializa grupos distintos", async () => {
    const orden: string[] = [];
    await Promise.all([
      withGroupLock("x", async () => {
        orden.push("x:entra");
        await sleep(20);
        orden.push("x:sale");
      }),
      withGroupLock("y", async () => {
        orden.push("y:entra");
        await sleep(1);
        orden.push("y:sale");
      }),
    ]);
    // El de otro room no espera: entra antes de que el primero termine.
    expect(orden.indexOf("y:entra")).toBeLessThan(orden.indexOf("x:sale"));
  });

  it("un turno que revienta NO deja el grupo trabado", async () => {
    await expect(
      withGroupLock("g2", async () => {
        throw new Error("revienta");
      })
    ).rejects.toThrow("revienta");

    // El siguiente tiene que poder entrar: si el lock se quedara tomado, el room entero
    // dejaría de responder y no habría ninguna señal de por qué.
    const ok = await withGroupLock("g2", async () => "vivo");
    expect(ok).toBe("vivo");
  });

  it("devuelve el valor de la función", async () => {
    expect(await withGroupLock("g3", async () => 42)).toBe(42);
  });
});
