import { createServerFn } from "@tanstack/react-start";
import { sessionUser } from "./chat";

// ── Emojis custom del workspace (Fase 4) ────────────────────────────────────
// La imagen se sube antes por /api/upload (EasyBits, storage privado) → fileId;
// aquí solo se registra el nombre → fileId. Listado abierto (para el picker);
// alta/baja solo el owner. Se reaccionan/renderizan como `:name:`.

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

export const listEmojisFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = await import("../db.server");
  return db.listCustomEmojis();
});

export const addEmojiFn = createServerFn({ method: "POST" })
  .validator((d: { name: string; fileId: string }) => d)
  .handler(async ({ data }) => {
    // Slack default: CUALQUIER member puede agregar emojis del workspace (no solo el owner).
    const me = await sessionUser();
    if (!me) throw new Error("inicia sesión");
    const name = normalizeName(data.name);
    if (!name) throw new Error("nombre inválido");
    if (!data.fileId) throw new Error("falta la imagen");
    const db = await import("../db.server");
    await db.addCustomEmoji(name, data.fileId, me.sub);
    return { ok: true as const, name };
  });

export const removeEmojiFn = createServerFn({ method: "POST" })
  .validator((d: { name: string }) => d)
  .handler(async ({ data }) => {
    // Borrar sí es restringido: el owner o QUIEN lo creó (no cualquier member borra el de otro).
    const me = await sessionUser();
    if (!me) throw new Error("inicia sesión");
    const db = await import("../db.server");
    const creator = await db.getCustomEmojiCreator(data.name);
    if (!me.isOwner && creator && creator !== me.sub) throw new Error("solo el owner o quien lo creó");
    const fileId = await db.removeCustomEmoji(data.name);
    // Borra también el objeto en EasyBits (best-effort).
    if (fileId) {
      const { deleteEasyBitsFile } = await import("./easybits-files.server");
      await deleteEasyBitsFile(fileId).catch(() => false);
    }
    return { ok: true as const };
  });
