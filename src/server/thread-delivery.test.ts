import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * El antecedente de "modifícalo" cuando la última entrega fue un ARCHIVO.
 *
 * Caso real (2026-08-08): el agente entregó un PDF, la persona escribió "brandeado con el
 * brandkit activo", y el agente parcheó una landing page HTML de diez minutos antes. El
 * puntero del hilo (`gc_thread_artifact`) sólo conoce doc/sheet/artifact, así que un
 * `eb-file` no lo mueve y el hint seguía presentando ese artefacto como el objeto de la
 * conversación.
 *
 * La DECISIÓN es donde estaba el bug: la comparación tiene que ser por fecha —para que la
 * regla se APAGUE sola cuando el artefacto vuelve a ser lo último— y no un simple "existe un
 * archivo"; en empate (resolución de 1 s de `unixepoch()`) gana el archivo, que es lo que la
 * persona acabó de recibir. Vive en línea en chat.ts y dm.ts, así que se comprueba sobre su
 * TEXTO (antes se probaba una copia local de la condición, que no cubría nada).
 */
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const leer = (p: string) => readFileSync(join(raiz, p), "utf8");

describe("antecedente de la conversación: archivo vs artefacto", () => {
  for (const f of ["server/chat.ts", "server/dm.ts"]) {
    it(`${f}: la regla compara fechas y en empate gana el archivo`, () => {
      expect(leer(f)).toMatch(/if \(entrega && entrega\.at >= \(currentDoc\.at \?\? 0\)\)/);
    });
  }
});
