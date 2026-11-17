// Limpiar las llaves de preview (`?k=`) que ya quedaron guardadas ANTES de que dejaran de publicarse
// (auditoría del 17-nov): `gt_factory_runs.preview_url` y los mensajes del hilo («🔎 Preview lista · [Abrir](…?k=…)»).
//
// ENSAYO por default: cuenta y enseña ejemplos con la llave tachada (nunca la imprime). Con `--apply` escribe.
// ⚠️ Corre dentro de `withNamespace` (un tenant por corrida): fuera cae a `SQLD_NAMESPACE`.
// Esto NO rota la llave de las cajas vivas (la liga vieja sigue abriéndolas hasta que la caja se recree o
// exista el endpoint de rotación del daemon): limpiar sólo evita que se siga LEYENDO en la base y el hilo.
//
// Uso: npx tsx scripts/limpiar-llaves-preview.mts <ns> [--apply]
import { withNamespace } from "../src/server/tenant.server";
import { dbq } from "../src/dbq.server";
import { scrubPreviewKeys, stripPreviewKey } from "../src/server/apps/preview-link";

const [ns, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
if (!ns) {
  console.error("uso: npx tsx scripts/limpiar-llaves-preview.mts <ns> [--apply]");
  process.exit(1);
}

/** Para mostrar: la llave tachada. */
const redact = (s: string) => s.replace(/([?&]k=)[^&#\s)\]]+/g, "$1•••");

await withNamespace(ns, async () => {
  const runs = await dbq("SELECT id, preview_url FROM gt_factory_runs WHERE preview_url LIKE '%k=%'");
  const dirtyRuns = runs.filter((r) => String(r.preview_url) !== (stripPreviewKey(String(r.preview_url)) ?? ""));
  console.log(`[${ns}] pedidos con llave en preview_url: ${dirtyRuns.length}`);
  for (const r of dirtyRuns.slice(0, 3)) console.log(`  #${r.id} ${redact(String(r.preview_url))}`);

  const msgs = await dbq("SELECT id, body FROM gc_messages WHERE body LIKE '%?k=%' OR body LIKE '%&k=%'");
  const dirtyMsgs = msgs.filter((m) => scrubPreviewKeys(String(m.body)) !== String(m.body));
  console.log(`[${ns}] mensajes con llave en el texto: ${dirtyMsgs.length}`);
  for (const m of dirtyMsgs.slice(0, 3)) console.log(`  msg ${m.id}: ${redact(String(m.body)).slice(0, 120)}`);

  if (!apply) {
    console.log("(ensayo: no se escribió nada; repite con --apply)");
    return;
  }
  for (const r of dirtyRuns) await dbq("UPDATE gt_factory_runs SET preview_url = ? WHERE id = ?", [stripPreviewKey(String(r.preview_url)), r.id]);
  for (const m of dirtyMsgs) await dbq("UPDATE gc_messages SET body = ? WHERE id = ?", [scrubPreviewKeys(String(m.body)), m.id]);
  console.log(`[${ns}] limpiados: ${dirtyRuns.length} pedidos y ${dirtyMsgs.length} mensajes`);
});
