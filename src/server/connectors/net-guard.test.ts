// El test más valioso de este trabajo: cada caso de aquí es un agujero real por el que se
// alcanzaría la red interna desde el proceso web (172.20.0.1:8080 es la API de sandboxes).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ default: { lookup: (...a: any[]) => lookup(...a) }, lookup: (...a: any[]) => lookup(...a) }));

import { assertPublicOrigin, __resetDnsCache } from "./net-guard.server";

/** Por defecto todo resuelve a una IP pública, para aislar la validación de forma. */
function resolvesPublic() {
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
}

beforeEach(() => {
  __resetDnsCache();
  lookup.mockReset();
  resolvesPublic();
  delete process.env.CONNECTORS_HOST_ALLOWLIST;
  delete process.env.CONNECTORS_ALLOW_HTTP;
});
afterEach(() => {
  delete process.env.CONNECTORS_HOST_ALLOWLIST;
  delete process.env.CONNECTORS_ALLOW_HTTP;
});

describe("assertPublicOrigin — lo que debe pasar", () => {
  it("acepta una instancia normal y devuelve el origin limpio", async () => {
    await expect(assertPublicOrigin("https://coregrid.odoo.com")).resolves.toBe("https://coregrid.odoo.com");
  });
  it("le pone https a un host pelado", async () => {
    await expect(assertPublicOrigin("coregrid.odoo.com")).resolves.toBe("https://coregrid.odoo.com");
  });
  it("descarta path, query y hash", async () => {
    await expect(assertPublicOrigin("https://coregrid.odoo.com/web/login?x=1#y")).resolves.toBe(
      "https://coregrid.odoo.com"
    );
  });
  it("aplica la plantilla de host (el caso Kommo)", async () => {
    await expect(assertPublicOrigin("acme", undefined, "https://{value}.kommo.com")).resolves.toBe(
      "https://acme.kommo.com"
    );
  });
  it("con plantilla, ignora que el usuario haya pegado una URL entera", async () => {
    await expect(assertPublicOrigin("https://acme.kommo.com/leads", undefined, "https://{value}.kommo.com")).resolves.toBe(
      "https://acme.kommo.com"
    );
  });
});

describe("assertPublicOrigin — la red interna", () => {
  const internos = [
    ["el bridge del host de sandboxes", "http://172.20.0.1:8080"],
    ["metadata de nube", "http://169.254.169.254/"],
    ["loopback por nombre", "https://localhost"],
    ["loopback v6", "http://[::1]"],
    ["loopback v4", "https://127.0.0.1"],
    ["red privada clase A", "https://10.0.0.5"],
    ["red privada clase C", "https://192.168.1.1"],
    ["decimal, que es 127.0.0.1", "http://2130706433/"],
    ["hexadecimal", "http://0x7f000001/"],
    ["sufijo interno", "https://odoo.internal"],
    ["sufijo .local", "https://odoo.local"],
  ] as const;
  for (const [que, url] of internos) {
    it(`rechaza ${que}`, async () => {
      await expect(assertPublicOrigin(url)).rejects.toThrow();
    });
  }

  it("rechaza un dominio público que RESUELVE a la red interna", async () => {
    lookup.mockResolvedValue([{ address: "172.20.0.1", family: 4 }]);
    await expect(assertPublicOrigin("https://malo.example.com")).rejects.toThrow(/interna/);
  });

  it("rechaza si UNA de varias respuestas es privada (round-robin)", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertPublicOrigin("https://mixto.example.com")).rejects.toThrow(/interna/);
  });

  it("rechaza una IPv4 mapeada en IPv6", async () => {
    lookup.mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertPublicOrigin("https://mapeado.example.com")).rejects.toThrow(/interna/);
  });

  it("rechaza direcciones únicas locales de IPv6", async () => {
    lookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    await expect(assertPublicOrigin("https://v6.example.com")).rejects.toThrow(/interna/);
  });

  it("rechaza NAT64, que traduce a IPv4", async () => {
    lookup.mockResolvedValue([{ address: "64:ff9b::a00:5", family: 6 }]);
    await expect(assertPublicOrigin("https://nat64.example.com")).rejects.toThrow(/interna/);
  });

  it("rechaza si el dominio no resuelve a nada", async () => {
    lookup.mockResolvedValue([]);
    await expect(assertPublicOrigin("https://vacio.example.com")).rejects.toThrow();
  });
});

describe("assertPublicOrigin — forma de la URL", () => {
  it("rechaza credenciales embebidas, que disfrazan el host real", async () => {
    await expect(assertPublicOrigin("https://user:pass@coregrid.odoo.com")).rejects.toThrow(/usuario y contraseña/);
  });
  it("rechaza http en producción: la API key viajaría en claro", async () => {
    await expect(assertPublicOrigin("http://coregrid.odoo.com")).rejects.toThrow(/https/);
  });
  it("rechaza un puerto arbitrario, que lo volvería un escáner de puertos", async () => {
    await expect(assertPublicOrigin("https://coregrid.odoo.com:22")).rejects.toThrow(/puerto/);
  });
  it("rechaza un host sin TLD", async () => {
    await expect(assertPublicOrigin("https://odoo")).rejects.toThrow();
  });
  it("rechaza vacío", async () => {
    await expect(assertPublicOrigin("   ")).rejects.toThrow();
  });
  it("con CONNECTORS_ALLOW_HTTP permite http y el puerto de Odoo (dev)", async () => {
    process.env.CONNECTORS_ALLOW_HTTP = "1";
    await expect(assertPublicOrigin("http://odoo.example.com:8069")).resolves.toBe("http://odoo.example.com:8069");
  });
});

describe("assertPublicOrigin — allowlists", () => {
  it("la del conector acota al proveedor", async () => {
    const def = { fields: [], allowHostSuffixes: ["kommo.com"] } as any;
    await expect(assertPublicOrigin("https://acme.kommo.com", def)).resolves.toBeTruthy();
    await expect(assertPublicOrigin("https://acme.example.com", def)).rejects.toThrow(/sólo admite/);
  });
  it("la del env acota el despliegue", async () => {
    process.env.CONNECTORS_HOST_ALLOWLIST = "odoo.com";
    await expect(assertPublicOrigin("https://coregrid.odoo.com")).resolves.toBeTruthy();
    await expect(assertPublicOrigin("https://otro.example.com")).rejects.toThrow(/no está autorizada/);
  });
});
