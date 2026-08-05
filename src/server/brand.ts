import { createServerFn } from "@tanstack/react-start";
import type { BrandFonts, BrandColors } from "#/lib/brand-tokens";
import { sessionUser } from "./chat";

// Server fns de la marca del workspace (Ajustes → Marca).
// La lectura es para cualquier miembro (el tema de la app lo usa todo el mundo);
// la escritura, sólo el owner.

async function requireOwner() {
  const user = await sessionUser();
  if (!user?.isOwner) throw new Error("solo el owner gestiona la marca");
  return user;
}

async function ready() {
  const { ensureSchema } = await import("./schema.server");
  await ensureSchema().catch(() => {});
  return import("./brand.server");
}

export const listBrandKitsFn = createServerFn({ method: "GET" }).handler(async () => {
  const user = await sessionUser();
  if (!user) throw new Error("no autenticado");
  const brand = await ready();
  return brand.listBrandKits();
});

export type SaveBrandInput = {
  id?: string;
  name: string;
  colors: BrandColors;
  fonts?: BrandFonts | null;
  logoKey?: string | null;
  logoDarkKey?: string | null;
  mood?: string | null;
};

export const saveBrandKitFn = createServerFn({ method: "POST" })
  .validator((d: SaveBrandInput) => d)
  .handler(async ({ data }) => {
    const user = await requireOwner();
    const brand = await ready();
    // normalizeColors lanza ante un hex inválido — la validación de borde vive ahí,
    // no en un `z.string()` libre como en el MCP de EasyBits.
    if (data.id) return brand.updateBrandKit(data.id, data);
    return brand.createBrandKit(data, user.sub);
  });

export const activateBrandKitFn = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    const brand = await ready();
    await brand.activateBrandKit(data.id);
    return { ok: true };
  });

export const extractBrandFromUrlFn = createServerFn({ method: "POST" })
  .validator((d: { url: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    // SSRF: esto hace `fetch` a una URL que escribe el usuario, desde una caja que ve el
    // bridge del host (172.20.0.1) y la red interna de la flota. Sólo http(s) público.
    const u = new URL(/^https?:\/\//i.test(data.url) ? data.url : `https://${data.url}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("solo http o https");
    if (
      /^(localhost|\[?::1\]?|.*\.local)$/i.test(u.hostname) ||
      /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)
    ) {
      throw new Error("esa dirección no es pública");
    }
    const { extractFromUrl } = await import("./brand-extract.server");
    return extractFromUrl(u.toString());
  });

export const extractBrandFromLogoFn = createServerFn({ method: "POST" })
  .validator((d: { key: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    // La key la acabamos de emitir nosotros en /api/brand-logo; el prefijo lo confirma.
    if (!data.key.startsWith("t3/")) throw new Error("key inválida");
    const { extractFromLogo } = await import("./brand-extract.server");
    return extractFromLogo(data.key);
  });

export const deleteBrandKitFn = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await requireOwner();
    const brand = await ready();
    await brand.deleteBrandKit(data.id);
    return { ok: true };
  });
