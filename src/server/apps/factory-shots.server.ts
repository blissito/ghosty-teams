// Evidencia visual en la tarjeta del veredicto: cómo se ve la preview del PR, en escritorio y
// en móvil. La captura la hace render-svc (Chromium de la flota) por el puente de Studio
// (`/api/v2/render/screenshot`), y la imagen se guarda en el storage de Teams (no en una
// firma de 7 días): la tarjeta firma la URL al pintarse.
//
// Best-effort y en segundo plano: si la preview no está lista o la captura falla, la tarjeta
// queda como antes. Nunca detiene el veredicto.
import { dbq } from "../../dbq.server";

export type Shot = { label: "desktop" | "mobile"; key: string };

const VIEWPORTS: Array<{ label: Shot["label"]; width: number; height: number }> = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
];

/** La URL a capturar: la preview con la ruta que pidió @check (conserva `?k=`). */
export function shotUrl(preview: string, path?: string | null): string {
  const u = new URL(preview);
  const p = String(path ?? "").trim();
  if (p.startsWith("/") && !p.startsWith("//")) {
    const [pathname, search] = p.split("?");
    u.pathname = pathname;
    if (search) for (const [k, v] of new URLSearchParams(search)) u.searchParams.set(k, v);
  }
  return u.toString();
}

async function screenshot(url: string, width: number, height: number): Promise<Buffer | null> {
  const { nativeRuntimeBase, partnerHeaders } = await import("../ghosty-runtime.server");
  const base = await nativeRuntimeBase();
  if (!base) return null;
  const { currentNamespace } = await import("../tenant.server");
  const body = JSON.stringify({ url, viewport: { width, height }, waitMs: 2000 });
  const res = await fetch(`${base}/api/v2/render/screenshot`, {
    method: "POST",
    headers: partnerHeaders(body, await currentNamespace()),
    body,
    signal: AbortSignal.timeout(100_000),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 1000 ? buf : null;
}

/** Captura la preview del pedido y la cuelga del veredicto. Espera a que la preview esté lista. */
export async function captureVerdictShots(runId: number, path?: string | null): Promise<void> {
  try {
    const R = await import("./factory-runs.server");
    // La preview puede ir un poco atrás del veredicto: se espera hasta ~3 min.
    let preview = await R.runPreview(runId);
    for (let i = 0; i < 6 && preview.state === "pending"; i++) {
      await new Promise((ok) => setTimeout(ok, 30_000));
      preview = await R.runPreview(runId);
    }
    if (preview.state !== "ready" || !preview.url) return;
    const storage = await import("../storage.server");
    if (!storage.storageConfigured()) return;
    const url = shotUrl(preview.url, path);
    const shots: Shot[] = [];
    for (const v of VIEWPORTS) {
      const png = await screenshot(url, v.width, v.height).catch(() => null);
      if (!png) continue;
      const put = await storage.put({ blob: new Blob([new Uint8Array(png)], { type: "image/png" }), contentType: "image/png", fileName: `pedido-${runId}-${v.label}.png` });
      shots.push({ label: v.label, key: put.key });
    }
    if (!shots.length) return;
    const rows = await dbq("SELECT verdict_json, channel_id FROM gt_factory_runs WHERE id = ?", [runId]);
    if (!rows[0]?.verdict_json) return;
    const verdict = JSON.parse(String(rows[0].verdict_json));
    await dbq("UPDATE gt_factory_runs SET verdict_json = ? WHERE id = ?", [JSON.stringify({ ...verdict, shots, shotPath: path ?? null }), runId]);
    void R.refreshRoom(Number(rows[0].channel_id));
  } catch (e) {
    console.error("[factory] capturas de la preview", e);
  }
}
