// Lo que se prueba aquí es lo que no perdona: la firma (un tercero la va a replicar y si
// cambia se le rompe la integración en silencio) y el guard de SSRF (la petición sale de
// NUESTRA red, con acceso al bridge del host).
//
// La cola —claim atómico, backoff, 8 intentos → dead— vive contra sqld y no se puede correr
// sin él; lo que la sostiene es el UNIQUE (hook_id, submission_id) del schema y el
// `RETURNING` del claim, que son SQL, no lógica.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { signBody, urlProhibida } from "./webhooks.server";

// `vi.spyOn` no puede tocar un namespace de ESM (no es configurable), así que el DNS se
// sustituye entero y cada prueba dice qué debe resolver.
let resuelve: () => Promise<{ address: string; family: number }[]> = async () => [
  { address: "93.184.216.34", family: 4 },
];
vi.mock("node:dns/promises", () => ({ default: {}, lookup: () => resuelve() }));

beforeAll(() => {
  process.env.GHOSTY_PARTNER_SECRET ||= "test-secret-para-firmar";
});

describe("firma de la entrega", () => {
  it("vector fijo: si esto cambia, se rompe la integración de alguien", async () => {
    // Canonical = `${ts}.${rawBody}`, HMAC-SHA256 en hex. Un tercero tiene que poder
    // reproducirlo leyendo sólo esta línea.
    const sig = await signBody("s3cr3t", 1754300000, '{"event":"ping"}');
    expect(sig).toBe(
      crypto
        .createHmac("sha256", "s3cr3t")
        .update('1754300000.{"event":"ping"}')
        .digest("hex")
    );
    expect(sig).toHaveLength(64);
  });

  it("el timestamp entra en la firma", async () => {
    // Sin él, un POST capturado se puede reenviar para siempre. La ventana la comprueba
    // quien recibe; lo que nos toca es que el ts esté FIRMADO y no sólo en un header.
    const a = await signBody("k", 1000, "{}");
    const b = await signBody("k", 1001, "{}");
    expect(a).not.toBe(b);
  });

  it("cada hook firma con su propio secreto", async () => {
    // `GHOSTY_PARTNER_SECRET` no se le entrega a un tercero jamás: es la raíz de auth del
    // IdP, del token del formulario y del hash de las IPs.
    expect(await signBody("hook-a", 1, "{}")).not.toBe(await signBody("hook-b", 1, "{}"));
  });
});

describe("guard de SSRF", () => {
  it("exige https", async () => {
    expect(await urlProhibida("http://ejemplo.com/hook")).toBe("tiene que ser https");
    expect(await urlProhibida("no-es-una-url")).toBe("la URL no es válida");
    expect(await urlProhibida("file:///etc/passwd")).toBeTruthy();
  });

  it("rechaza la red interna por NOMBRE", async () => {
    expect(await urlProhibida("https://localhost/hook")).toBeTruthy();
    expect(await urlProhibida("https://algo.internal/hook")).toBeTruthy();
  });

  it("rechaza la red interna por lo que RESUELVE el dominio", async () => {
    // Éste es el caso real: `hook.midominio.com` con un A a 10.0.0.5 pasaría cualquier
    // comprobación de texto. Y 169.254.169.254 es el metadata del proveedor.
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "172.20.0.1"]) {
      resuelve = async () => [{ address: ip, family: 4 }];
      expect(await urlProhibida("https://parece-publico.com/hook")).toBe(
        "no se puede apuntar a la red interna"
      );
    }
  });

  it("rechaza IPv6 interna, incluida la mapeada", async () => {
    for (const ip of ["::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      resuelve = async () => [{ address: ip, family: 6 }];
      expect(await urlProhibida("https://parece-publico.com/hook")).toBeTruthy();
    }
  });

  it("deja pasar una pública de verdad", async () => {
    resuelve = async () => [{ address: "93.184.216.34", family: 4 }];
    expect(await urlProhibida("https://ejemplo.com/hook")).toBeNull();
  });

  it("un dominio que no resuelve NO se da por bueno", async () => {
    resuelve = async () => { throw new Error("ENOTFOUND"); };
    expect(await urlProhibida("https://no-existe.test/hook")).toBeTruthy();
  });
});
