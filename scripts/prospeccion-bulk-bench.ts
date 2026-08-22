/**
 * Cuánto tarda importar una hoja grande, MEDIDO contra la base real.
 *
 * Uso: npx tsx --env-file=.env scripts/prospeccion-bulk-bench.ts [filas]
 *
 * Existe porque la primera versión hacía un INSERT por fila y una hoja de 10,728 filas
 * tardaba ~52 minutos. Un número inventado no habría cazado eso; éste sí.
 */
import { withNamespace } from "../src/server/tenant.server";

const N = Number(process.argv[2] ?? 10728);
const NS = process.env.SQLD_NAMESPACE ?? "default";

async function main() {
  await withNamespace(NS, async () => {
    const { ensureSchema } = await import("../src/server/schema.server");
    await ensureSchema();
    const L = await import("../src/server/prospeccion/lists.server");
    const { dbq, num } = await import("../src/dbq.server");

    const listId = await L.createList({
      name: `__bench_${Date.now()}`,
      criteria: null,
      source: "manual",
      createdBy: "bench",
    });

    const rows = Array.from({ length: N }, (_, i) => ({
      name: `NEGOCIO ${i}`,
      phone: `55${String(10000000 + i).slice(0, 8)}`,
      email: i % 3 === 0 ? `n${i}@ejemplo.mx` : null,
      website: i % 2 === 0 ? `https://n${i}.mx` : null,
      address: `Calle ${i}, Col. Prueba`,
      category: "Salón de belleza",
      data: { tamano: { v: "0 a 5 personas", src: "importado" }, cp: { v: "02000", src: "importado" } },
    }));

    console.log(`\nInsertando ${N} filas…`);
    const t0 = performance.now();
    let ultimo = 0;
    await L.insertRows(listId, rows, (done, total) => {
      const pct = Math.round((done / total) * 100);
      if (pct >= ultimo + 20) { ultimo = pct; console.log(`  ${pct}% · ${done}/${total} · ${Math.round(performance.now() - t0)}ms`); }
    });
    const ms = performance.now() - t0;

    const cuenta = await dbq(`SELECT COUNT(*) AS n FROM gt_prosp_rows WHERE list_id = ?`, [listId]);
    const guardadas = num(cuenta[0].n);

    console.log(`\n  ${guardadas}/${N} filas guardadas en ${(ms / 1000).toFixed(1)}s`);
    console.log(`  ${(ms / N).toFixed(2)} ms por fila`);
    console.log(`  antes (1 INSERT por fila, ~290ms de ida y vuelta): ${((N * 290) / 60000).toFixed(0)} min`);

    // Leer de vuelta también importa: la pantalla las pinta todas.
    const t1 = performance.now();
    const leidas = await L.listRows(listId, 20000);
    console.log(`  leer ${leidas.length} de vuelta: ${Math.round(performance.now() - t1)}ms`);

    await L.purgeList(listId);
    console.log("  (limpiado)\n");
    process.exit(guardadas === N ? 0 : 1);
  });
}
main().catch((e) => { console.error("✗", e); process.exit(1); });
