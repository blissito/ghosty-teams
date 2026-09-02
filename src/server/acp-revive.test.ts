// La caja de un agente ACP ya no existe → se le pide al dueño que la recree y se vuelve a
// mirar. Antes esto era un error terminal («hay que volver a levantarla») sin nadie que
// pudiera hacerlo.
import { afterEach, describe, expect, it, vi } from "vitest";

import { acpHandshake, BoxGoneError } from "./acp-client.server";
import { deriveReviveUrl } from "./acp-revive.server";

describe("deriveReviveUrl", () => {
  it("reconoce el dominio fijo de un agente de EasyBits", () => {
    expect(deriveReviveUrl("wss://acp-6a50056c1234567890abcdef.sandboxes.easybits.cloud/acp")).toBe(
      "https://www.easybits.cloud/api/v2/agents/6a50056c1234567890abcdef/revive",
    );
  });
  it("una URL con el sandboxId dentro no tiene identidad que revivir", () => {
    expect(deriveReviveUrl("wss://sb-7a2cf166-f272-49df-b82f-748d6581814c-3000.sandboxes.easybits.cloud/acp")).toBeNull();
    expect(deriveReviveUrl("no es url")).toBeNull();
  });
});

describe("acpHandshake ante una caja que ya no existe", () => {
  afterEach(() => vi.unstubAllGlobals());
  const gone = () => new Response(JSON.stringify({ error: "preview host not found" }), { status: 404 });

  it("sin revive: dice que no existe y no reintenta", async () => {
    const fetchMock = vi.fn(async () => gone());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      acpHandshake({ wsUrl: "wss://acp-x.example.test/acp", ns: "acme", sub: "u1", timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(BoxGoneError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("con revive: lo llama UNA vez, vuelve a mirar, y si sigue sin caja lo dice", async () => {
    const fetchMock = vi.fn(async () => gone());
    vi.stubGlobal("fetch", fetchMock);
    const onGone = vi.fn(async () => {});
    await expect(
      acpHandshake({ wsUrl: "wss://acp-y.example.test/acp", ns: "acme", sub: "u1", timeoutMs: 300, onGone }),
    ).rejects.toThrow(/no se pudo volver a levantar/);
    expect(onGone).toHaveBeenCalledTimes(1);
    // Se volvió a preguntar DESPUÉS del revive: sin olvidar el host, la segunda mirada
    // habría salido del caché y no habría comprobado nada.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
