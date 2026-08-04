import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Aislamiento entre tenants.
 *
 * Existe porque en un solo día aparecieron CINCO fugas del mismo patrón, todas por la
 * misma causa: el tenant se resuelve de forma implícita —por host o por contexto async— y
 * cualquier código que se salga de esa ventana pierde la resolución. `currentNamespace()`
 * entonces cae a `SQLD_NAMESPACE`, que en producción es el namespace de un workspace REAL.
 *
 * Las reglas se documentan en el CLAUDE.md, y las reglas de disciplina se rompen: se
 * rompió en `quick-calls.ts`, en `calendly.server.ts` y en el sidecar de co-edición, en un
 * repo que ya las tenía escritas. Esto no depende de que nadie recuerde nada.
 *
 * Lo que se comprueba no es "la función devuelve X", sino **contra qué namespace habló**.
 */

// El fake registra el ns de cada query en vez de ejecutarla.
const consultas: { ns: string; sql: string }[] = [];
let nsActual = "";

vi.mock("../dbq.server", () => ({
  dbq: async (sql: string) => {
    consultas.push({ ns: nsActual, sql: String(sql) });
    return [];
  },
  dbqMany: vi.fn(),
  dbqManySettled: vi.fn(),
  num: (v: unknown) => Number(v),
}));

// `withNamespace` real (AsyncLocalStorage); el fake de dbq lee lo que esté activo.
const { withNamespace, currentNamespace } = await import("./tenant.server");

/** Corre `fn` bajo un tenant y devuelve contra qué namespaces habló. */
async function nsTocados(ns: string, fn: () => Promise<unknown>): Promise<string[]> {
  consultas.length = 0;
  await withNamespace(ns, async () => {
    nsActual = await currentNamespace();
    await fn();
  });
  return [...new Set(consultas.map((c) => c.ns))];
}

beforeEach(() => {
  consultas.length = 0;
  nsActual = "";
});

describe("aislamiento entre tenants", () => {
  it("una operación bajo A no toca B", async () => {
    const { listConnectorHolders } = await import("./connectors/store.server");
    expect(await nsTocados("tenant-a", listConnectorHolders)).toEqual(["tenant-a"]);
    expect(await nsTocados("tenant-b", listConnectorHolders)).toEqual(["tenant-b"]);
  });

  it("withNamespace gana sobre cualquier resolución por host", async () => {
    // El caso del sidecar de co-edición y del reaper: no hay request que mirar, así que
    // el ns tiene que venir del contexto explícito o se cae al env.
    await withNamespace("tenant-a", async () => {
      expect(await currentNamespace()).toBe("tenant-a");
      await withNamespace("tenant-b", async () => {
        expect(await currentNamespace()).toBe("tenant-b");
      });
      expect(await currentNamespace()).toBe("tenant-a");
    });
  });

  it("el contexto sobrevive a un await encadenado", async () => {
    // Los fire-and-forget dependen de esto. Si alguna vez deja de cumplirse, el refresco
    // de meta y cualquier otra tarea diferida escribirían en el tenant equivocado.
    await withNamespace("tenant-a", async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(await currentNamespace()).toBe("tenant-a");
    });
  });

  it("dos tenants en paralelo no se mezclan", async () => {
    // AsyncLocalStorage aísla ramas concurrentes; si esto fallara, dos turnos simultáneos
    // de workspaces distintos podrían cruzarse.
    const vistos: string[] = [];
    await Promise.all([
      withNamespace("tenant-a", async () => {
        await new Promise((r) => setTimeout(r, 5));
        vistos.push(await currentNamespace());
      }),
      withNamespace("tenant-b", async () => {
        vistos.push(await currentNamespace());
      }),
    ]);
    expect(vistos.sort()).toEqual(["tenant-a", "tenant-b"]);
  });
});

describe("cachés de módulo: la clave lleva el namespace", () => {
  // Un Map a nivel de módulo keyed sólo por `sub` sirve datos de un workspace en otro. Ya
  // pasó dos veces: el `inFlight` de meta.server.ts y el `digestCache` de Calendly, cuyo
  // valor —agenda y próximas citas— se inyecta al prompt del agente.
  //
  // Se comprueba sobre el FUENTE porque el estado es privado del módulo y no hay forma de
  // observarlo desde fuera sin exportarlo sólo para el test.
  const casos: { archivo: string; cache: string }[] = [
    { archivo: "src/server/connectors/calendly.server.ts", cache: "digestCache" },
    { archivo: "src/server/connectors/meta.server.ts", cache: "inFlight" },
  ];

  for (const { archivo, cache } of casos) {
    it(`${cache} de ${archivo.split("/").pop()} usa una clave con ns`, async () => {
      const fs = await import("node:fs");
      const src = fs.readFileSync(archivo, "utf8");
      // Toda escritura al caché tiene que ir con una clave que incluya el namespace.
      const escrituras = src.match(new RegExp(`${cache}\\.(set|add)\\(([^,)]+)`, "g")) ?? [];
      expect(escrituras.length).toBeGreaterThan(0);
      for (const e of escrituras) {
        expect(e, `${e} — la clave debe incluir el ns`).toMatch(/ns|clave|key/);
      }
    });
  }
});
