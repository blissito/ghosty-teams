// ── Brand kits del workspace: CRUD y resolución ─────────────────────────────
// La fila guarda lo mínimo; TODO lo derivado vive en `#/lib/brand-tokens` (isomorfo).
// Este módulo sólo persiste, resuelve el activo y sube logos.

import { dbq } from "#/dbq.server";
import {
  BRAND_MOODS,
  type BrandFonts,
  type BrandKit,
  type BrandMood,
  normalizeColors,
} from "#/lib/brand-tokens";
import * as storage from "./storage.server";

export type BrandKitRow = BrandKit & {
  isActive: boolean;
  logoKey: string | null;
  logoDarkKey: string | null;
  createdAt: number;
};

// El activo se pide en CADA publicación (formulario, PDF, artefacto). Sin caché serían
// dos queries por render. TTL corto: editar la marca tiene que verse casi al momento.
const CACHE_MS = 20_000;
const activeCache = new Map<string, { at: number; kit: BrandKitRow | null }>();

/** Invalida el activo de un namespace. Se llama en cada escritura. */
export function invalidateBrand(ns: string): void {
  activeCache.delete(ns);
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToKit(r: Record<string, string | null>): BrandKitRow {
  const logoKey = r.logo_key || null;
  const logoDarkKey = r.logo_dark_key || null;
  return {
    id: String(r.id),
    name: String(r.name || "Marca"),
    colors: safeJson(r.colors_json, {
      primary: "#7c3aed", secondary: "#a78bfa", accent: "#f59e0b", surface: "#ffffff",
    }),
    fonts: safeJson<BrandFonts | null>(r.fonts_json, null),
    logoUrl: logoKey ? storage.publicUrl(logoKey) : null,
    logoDarkUrl: logoDarkKey ? storage.publicUrl(logoDarkKey) : null,
    mood: (r.mood as BrandMood) || null,
    isActive: r.is_active === "1",
    logoKey,
    logoDarkKey,
    createdAt: Number(r.created_at || 0),
  };
}

const COLS =
  "id, name, colors_json, fonts_json, logo_key, logo_dark_key, mood, is_active, created_at";

export async function listBrandKits(): Promise<BrandKitRow[]> {
  const rows = await dbq(
    `SELECT ${COLS} FROM gt_brand_kits ORDER BY COALESCE(is_active,0) DESC, created_at DESC`
  );
  return rows.map(rowToKit);
}

export async function getBrandKit(id: string): Promise<BrandKitRow | null> {
  const rows = await dbq(`SELECT ${COLS} FROM gt_brand_kits WHERE id = ?`, [id]);
  return rows[0] ? rowToKit(rows[0]) : null;
}

/**
 * El kit activo del tenant, o null. Es lo que consumen todas las superficies.
 *
 * ⚠️ NUNCA lanza: si la tabla no existe todavía (tenant que aún no corrió `ensureSchema`)
 * o el sqld parpadea, un PDF o un formulario tienen que salir SIN marca, no fallar. La
 * marca es decoración; el documento es el trabajo de alguien.
 */
export async function activeBrandKit(ns?: string): Promise<BrandKitRow | null> {
  const key = ns || "";
  const hit = activeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.kit;
  let kit: BrandKitRow | null = null;
  try {
    const rows = await dbq(`SELECT ${COLS} FROM gt_brand_kits WHERE is_active = 1 LIMIT 1`);
    kit = rows[0] ? rowToKit(rows[0]) : null;
  } catch {
    return hit?.kit ?? null; // stale-while-error, como resolveNamespace
  }
  activeCache.set(key, { at: Date.now(), kit });
  return kit;
}

export type BrandKitInput = {
  name: string;
  colors: BrandKit["colors"];
  fonts?: BrandFonts | null;
  logoKey?: string | null;
  logoDarkKey?: string | null;
  mood?: string | null;
};

function cleanMood(m: string | null | undefined): BrandMood | null {
  return m && (BRAND_MOODS as readonly string[]).includes(m) ? (m as BrandMood) : null;
}

function cleanFonts(f: BrandFonts | null | undefined): BrandFonts | null {
  if (!f) return null;
  // Sólo el nombre de la familia: acaba dentro de un `font-family` y de una URL de
  // Google Fonts. Nada de comillas, llaves ni punto y coma.
  const ok = (v?: string) => {
    const s = String(v || "").replace(/[^A-Za-z0-9 +-]/g, "").trim().slice(0, 48);
    return s || undefined;
  };
  const out: BrandFonts = {};
  if (ok(f.heading)) out.heading = ok(f.heading);
  if (ok(f.body)) out.body = ok(f.body);
  return out.heading || out.body ? out : null;
}

export async function createBrandKit(input: BrandKitInput, createdBy: string, ns?: string): Promise<BrandKitRow> {
  const id = crypto.randomUUID();
  const colors = normalizeColors(input.colors); // lanza si un hex es inválido
  const existing = await dbq("SELECT COUNT(*) AS n FROM gt_brand_kits");
  const first = Number(existing[0]?.n || 0) === 0;
  await dbq(
    `INSERT INTO gt_brand_kits (id, name, colors_json, fonts_json, logo_key, logo_dark_key, mood, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(input.name || "Marca").slice(0, 60),
      JSON.stringify(colors),
      input.fonts ? JSON.stringify(cleanFonts(input.fonts)) : null,
      input.logoKey || null,
      input.logoDarkKey || null,
      cleanMood(input.mood),
      first ? 1 : null, // el primero se activa solo; nadie crea una marca para no usarla
      createdBy,
    ]
  );
  invalidateBrand(ns || "");
  return (await getBrandKit(id))!;
}

export async function updateBrandKit(
  id: string,
  patch: Partial<BrandKitInput>,
  ns?: string
): Promise<BrandKitRow | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(String(patch.name).slice(0, 60));
  }
  if (patch.colors !== undefined) {
    sets.push("colors_json = ?");
    args.push(JSON.stringify(normalizeColors(patch.colors)));
  }
  if (patch.fonts !== undefined) {
    sets.push("fonts_json = ?");
    args.push(patch.fonts ? JSON.stringify(cleanFonts(patch.fonts)) : null);
  }
  if (patch.logoKey !== undefined) {
    sets.push("logo_key = ?");
    args.push(patch.logoKey || null);
  }
  if (patch.logoDarkKey !== undefined) {
    sets.push("logo_dark_key = ?");
    args.push(patch.logoDarkKey || null);
  }
  if (patch.mood !== undefined) {
    sets.push("mood = ?");
    args.push(cleanMood(patch.mood));
  }
  if (!sets.length) return getBrandKit(id);
  sets.push("updated_at = unixepoch()");
  args.push(id);
  await dbq(`UPDATE gt_brand_kits SET ${sets.join(", ")} WHERE id = ?`, args);
  invalidateBrand(ns || "");
  return getBrandKit(id);
}

/**
 * Activa un kit. Dos writes, pero el índice parcial `gt_brand_active` garantiza el
 * invariante aunque el segundo falle: en el peor caso el workspace se queda sin kit
 * activo (recuperable con un clic), nunca con dos.
 */
export async function activateBrandKit(id: string, ns?: string): Promise<void> {
  await dbq("UPDATE gt_brand_kits SET is_active = NULL WHERE is_active = 1");
  await dbq("UPDATE gt_brand_kits SET is_active = 1, updated_at = unixepoch() WHERE id = ?", [id]);
  invalidateBrand(ns || "");
}

export async function deleteBrandKit(id: string, ns?: string): Promise<void> {
  const kit = await getBrandKit(id);
  await dbq("DELETE FROM gt_brand_kits WHERE id = ?", [id]);
  // Si se borró el activo, promueve el más reciente: quedarse sin marca por borrar un
  // kit viejo sorprende, y el estado "sin marca" ya existe (no haber creado ninguno).
  if (kit?.isActive) {
    const next = await dbq("SELECT id FROM gt_brand_kits ORDER BY created_at DESC LIMIT 1");
    if (next[0]?.id) await activateBrandKit(String(next[0].id), ns);
  }
  invalidateBrand(ns || "");
}

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]);
const LOGO_MAX = 2 * 1024 * 1024;

/**
 * Sube un logo al bucket PÚBLICO y devuelve su key. Público a propósito: el logo se
 * pinta en un formulario que responde alguien sin sesión y en un PDF que se reenvía por
 * correo — una URL firmada que caduca dejaría huecos en documentos ya repartidos.
 */
export async function putLogo(blob: Blob, fileName: string, contentType: string): Promise<string> {
  if (!storage.storageConfigured()) throw new Error("storage no configurado");
  if (!LOGO_TYPES.has(contentType)) throw new Error(`tipo no permitido: ${contentType}`);
  if (blob.size > LOGO_MAX) throw new Error("el logo pasa de 2 MB");
  const put = await storage.put({ blob, contentType, fileName, visibility: "public" });
  return put.key;
}
