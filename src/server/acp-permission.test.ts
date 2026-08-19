// El registro de permisos ACP: el punto de encuentro entre un turno detenido y un clic que
// llega en otra petición HTTP.
//
// Lo que hay que probar no es que un Map guarde cosas, sino las tres reglas que lo hacen
// seguro: que el silencio rechace, que un permiso no se pueda contestar dos veces, y que el
// `ns` de verdad aísle.
import { describe, expect, it } from "vitest";

import {
  barrerPermisos,
  esperarPermiso,
  permisoVivo,
  resolverPermiso,
} from "./acp-permission.server";

const permiso = (askId: string) => ({
  askId,
  title: "¿Borro el archivo?",
  options: [
    { id: "allow", label: "Sí" },
    { id: "deny", label: "No" },
  ],
});

describe("permisos ACP en vuelo", () => {
  it("el clic desbloquea el turno con la opción elegida", async () => {
    const p = esperarPermiso("ns-a", permiso("k1"));
    expect(permisoVivo("ns-a", "k1")).toBe(true);
    expect(resolverPermiso("ns-a", "k1", "allow")).toBe(true);
    await expect(p).resolves.toBe("allow");
    // Ya no está esperando: el turno siguió.
    expect(permisoVivo("ns-a", "k1")).toBe(false);
  });

  it("contestar dos veces devuelve false en vez de fallar en silencio", async () => {
    const p = esperarPermiso("ns-a", permiso("k2"));
    expect(resolverPermiso("ns-a", "k2", "allow")).toBe(true);
    // El segundo clic —otra pestaña, otra persona— tiene que poder decirlo.
    expect(resolverPermiso("ns-a", "k2", "deny")).toBe(false);
    await expect(p).resolves.toBe("allow");
  });

  it("el silencio se lee como NO", async () => {
    // Un permiso que se concede porque nadie estaba mirando no es un permiso.
    await expect(esperarPermiso("ns-a", permiso("k3"), 20)).resolves.toBeNull();
    expect(permisoVivo("ns-a", "k3")).toBe(false);
  });

  it("null rechaza explícitamente", async () => {
    const p = esperarPermiso("ns-a", permiso("k4"));
    expect(resolverPermiso("ns-a", "k4", null)).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  it("⚠️ otro workspace NO puede autorizar por ti", async () => {
    // Ésta es la razón de que la clave lleve el `ns`. Sin ella, alguien de otro espacio que
    // se hiciera del askId podría autorizarle a un agente ajeno que borre un archivo.
    const p = esperarPermiso("ns-a", permiso("mismo-id"));
    expect(resolverPermiso("ns-b", "mismo-id", "allow")).toBe(false);
    expect(permisoVivo("ns-a", "mismo-id")).toBe(true);

    // Y el de al lado sigue siendo suyo: resolver uno no toca al otro.
    const q = esperarPermiso("ns-b", permiso("mismo-id"));
    expect(resolverPermiso("ns-b", "mismo-id", "deny")).toBe(true);
    await expect(q).resolves.toBe("deny");
    expect(permisoVivo("ns-a", "mismo-id")).toBe(true);

    resolverPermiso("ns-a", "mismo-id", "allow");
    await expect(p).resolves.toBe("allow");
  });

  it("el barrido de huérfanos rechaza lo que quedó colgado", async () => {
    const p = esperarPermiso("ns-c", permiso("k5"), 60_000);
    // maxEdad 0 ⇒ todo lo vivo cuenta como viejo.
    expect(barrerPermisos(0)).toBeGreaterThanOrEqual(1);
    await expect(p).resolves.toBeNull();
    expect(permisoVivo("ns-c", "k5")).toBe(false);
  });
});
