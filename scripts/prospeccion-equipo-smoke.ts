/**
 * Smoke del guard de EQUIPO: dos personas, la misma lista, el mismo prospecto.
 * Uso: npx tsx --env-file=.env scripts/prospeccion-equipo-smoke.ts
 *
 * El fallo que persigue: la llave de idempotencia es `fila:canal:campaña`, así que la
 * campaña de Ana y la de Luis son llaves DISTINTAS y los dos correos salen. Al prospecto
 * le llegan dos con horas de diferencia — que es lo que produce una queja de spam.
 */
import { withNamespace } from "../src/server/tenant.server";

let f = 0;
const check = (l: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`);
  if (!ok) f++;
};

await withNamespace(process.env.SQLD_NAMESPACE ?? "default", async () => {
  await (await import("../src/server/schema.server")).ensureSchema();
  const { dbq } = await import("../src/dbq.server");
  const L = await import("../src/server/prospeccion/lists.server");
  const T = await import("../src/server/prospeccion/touches.server");
  const S = await import("../src/server/prospeccion/send.server");

  const listId = await L.createList({ name: `__equipo_${Date.now()}`, criteria: null, source: "manual", createdBy: "ana" });
  await L.insertRows(listId, [{ name: "Dental X", email: `eq_${Date.now()}@ejemplo-inexistente.mx` }]);
  const [row] = await L.listRows(listId);

  console.log("\n── Antes de que nadie lo toque ──");
  const antes = await S.planSend({ listId, campaign: "", rows: [row] });
  check("iría el correo", antes.irian === 1);
  check("nadie en descanso", antes.enDescanso === 0);

  console.log("\n── ANA le escribe ──");
  const t1 = await T.reserveTouch({ listId, rowId: row.id, channel: "email", campaign: "ana-agosto", bySub: "ana", byName: "Ana" });
  await T.markSent(t1!);
  const ult = await T.lastTouch(row.id);
  check("la bitácora guarda QUIÉN", ult?.byName === "Ana", "«Luis le escribió hace 3 días» se puede accionar; «bloqueado» no");

  console.log("\n── LUIS intenta el mismo día, con SU campaña ──");
  const t2 = await T.reserveTouch({ listId, rowId: row.id, channel: "email", campaign: "luis-agosto", bySub: "luis", byName: "Luis" });
  check("la idempotencia NO lo frena", t2 !== null, "⚠️ otra campaña = otra llave: aquí estaba el hueco");

  const conGuard = await S.planSend({ listId, campaign: "", rows: [row] });
  check("pero el GUARD sí", conGuard.irian === 0);
  check("y cuenta el descanso", conGuard.enDescanso === 1);
  check("diciendo quién fue", (conGuard.descansoNota ?? "").includes("Ana"), conGuard.descansoNota ?? "");

  console.log("\n── Pasada la semana ──");
  await dbq(`UPDATE gt_prosp_touches SET sent_at = unixepoch() - ? WHERE id = ?`, [(T.COOLDOWN_DAYS + 1) * 86400, t1!]);
  const despues = await S.planSend({ listId, campaign: "", rows: [row] });
  check("vuelve a poder escribírsele", despues.irian === 1, `descansan ${T.COOLDOWN_DAYS} días`);

  await L.purgeList(listId);
  await dbq(`DELETE FROM gt_prosp_touches WHERE list_id = ?`, [listId]);
  console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}\n`);
});
process.exit(f ? 1 : 0);
