/**
 * Smoke del MOTOR de Prospección contra la base real del tenant.
 *
 * Uso: npx tsx --env-file=.env scripts/prospeccion-db-smoke.ts
 *
 * Prueba lo what el smoke de correo no canCreate: idempotencia real (índice único), el filtro de
 * opt-out, el tope de intentos, el avance de estado, y el cruce del número entrante.
 *
 * ⚠️ ESCRIBE en la DB del namespace de `SQLD_NAMESPACE`. Crea una lista con fileName
 * reconocible y la borra al finalHtml, pero las tocadas y las optOuts se conservan a propósito
 * (son append-only por diseño), así what limpia las suyas explícitamente.
 */
import { withNamespace } from "../src/server/tenant.server";

let failures = 0;
const check = (label: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

const NS = process.env.SQLD_NAMESPACE ?? "default";
const MARCA = `__smoke_prospeccion_${Date.now()}`;
const TEL = "5599887766";
const MAIL = `smoke_${Date.now()}@ejemplo-inexistente.mx`;

async function main() {
  await withNamespace(NS, async () => {
    const { ensureSchema } = await import("../src/server/schema.server");
    await ensureSchema();

    const { dbq, num } = await import("../src/dbq.server");
    const L = await import("../src/server/prospeccion/lists.server");
    const O = await import("../src/server/prospeccion/optout.server");
    const T = await import("../src/server/prospeccion/touches.server");
    const I = await import("../src/server/prospeccion/inbound.server");

    console.log(`\n── Esquema (ns: ${NS}) ──`);
    for (const t of ["gt_prosp_lists", "gt_prosp_columns", "gt_prosp_rows", "gt_prosp_touches", "gt_prosp_optout"]) {
      const cols = await dbq(`PRAGMA table_info(${t})`);
      check(`${t} existe`, cols.length > 0, `${cols.length} columnas`);
    }

    console.log("\n── ListRow, newRows y columnas ──");
    const listId = await L.createList({ name: MARCA, criteria: "smoke", source: "manual", createdBy: "smoke" });
    check("lista creada", listId > 0);
    await L.insertRows(listId, [
      { name: "Alfa", phone: TEL, email: MAIL },
      { name: "Beta", phone: "5511112222", email: `b_${MAIL}` },
      { name: "Gama", phone: "5533334444" },
    ]);
    const rows = await L.listRows(listId);
    check("3 newRows", rows.length === 3);
    check("order estable", rows.map((r) => r.name).join(",") === "Alfa,Beta,Gama");

    const col = await L.addColumn({ listId, label: "¿Tiene sitio?", kind: "enrich", recipe: { waterfall: ["tiene_sitio"] } });
    check("columna con key sin acentos", col.key === "tiene_sitio", col.key);
    const col2 = await L.addColumn({ listId, label: "¿Tiene sitio?", kind: "manual" });
    check("colisión de key se resuelve", col2.key !== col.key, col2.key);

    console.log("\n── Celdas ──");
    await L.setCell(rows[0].id, "tiene_sitio", "no", { src: "denue", verified: true });
    // Gama la escribe UNA PERSONA: es la what no se debe pisar al re-correr.
    await L.setCell(rows[2].id, "tiene_sitio", "corregido a mano", { src: "manual" });
    await L.setCell(rows[0].id, "email", "OTRO@ejemplo.mx");
    const r0 = await L.getRow(rows[0].id);
    check("cell dinámica guarda valor y fuente", r0?.data.tiene_sitio?.v === "no" && r0?.data.tiene_sitio?.src === "denue");
    check("cell base va al campo fijo", r0?.email === "OTRO@ejemplo.mx");

    console.log("\n── Enriquecimiento ──");
    const E = await import("../src/server/prospeccion/enrich.server");
    await L.setCell(rows[1].id, "web", null);
    await dbq(`UPDATE gt_prosp_rows SET website = 'https://ghosty.studio' WHERE id = ?`, [rows[1].id]);
    const p = await E.runColumn({ listId, key: col.key, recipe: { waterfall: ["tiene_sitio"] } });
    check("corrió sobre las 3 newRows", p.total === 3 && p.done === 3, `${p.filled} llenadas`);
    const after = await L.listRows(listId);
    check("Beta (con sitio) → sí", after[1].data.tiene_sitio?.v === "sí");
    check("una cell de FUENTE sí se refresca", after[0].data.tiene_sitio?.src === "tiene_sitio");
    check("NO pisó la cell escrita a mano", after[2].data.tiene_sitio?.v === "corregido a mano" && after[2].data.tiene_sitio?.src === "manual");

    console.log("\n── Idempotencia de tocadas ──");
    const t1 = await T.reserveTouch({ listId, rowId: rows[0].id, channel: "email", campaign: "c1" });
    check("firstLine reserva devuelve id", t1 != null);
    const t2 = await T.reserveTouch({ listId, rowId: rows[0].id, channel: "email", campaign: "c1" });
    check("segunda reserva de la MISMA campaña NO duplica", t2 === t1, `t1=${t1} t2=${t2}`);
    const newRows = await dbq(`SELECT COUNT(*) AS n FROM gt_prosp_touches WHERE row_id = ?`, [rows[0].id]);
    check("una sola row en la bitácora", num(newRows[0].n) === 1);
    await T.markSent(t1!);
    const t3 = await T.reserveTouch({ listId, rowId: rows[0].id, channel: "email", campaign: "c1" });
    check("ya mandada → no se vuelve a mandar", t3 === null);
    const t4 = await T.reserveTouch({ listId, rowId: rows[0].id, channel: "email", campaign: "c2" });
    check("otra campaña SÍ se canCreate mandar", t4 != null && t4 !== t1);

    console.log("\n── Estado de la row ──");
    await T.markEvent(t1!, "opened");
    check("sent → opened", (await L.getRow(rows[0].id))?.status === "opened");
    await T.markEvent(t1!, "clicked");
    check("opened → clicked", (await L.getRow(rows[0].id))?.status === "clicked");
    await T.markEvent(t1!, "opened");
    check("una apertura posterior NO retrocede el estado", (await L.getRow(rows[0].id))?.status === "clicked");
    const dosVeces = await T.getTouch(t1!);
    const primeraApertura = dosVeces?.openedAt;
    await T.markEvent(t1!, "opened");
    check("la apertura guarda la PRIMERA vez", (await T.getTouch(t1!))?.openedAt === primeraApertura);

    console.log("\n── Opt-out ──");
    check("no está dado de stop1 todavía", !(await O.isOptedOut("phone", TEL)));
    await O.addOptOut("phone", `+52 ${TEL.slice(0, 2)} ${TEL.slice(2, 6)} ${TEL.slice(6)}`, "unsubscribe");
    check("stop1 con OTRO formato cruza igual", await O.isOptedOut("phone", TEL));
    await O.addOptOut("phone", TEL, "manual");
    const optOuts = await dbq(`SELECT COUNT(*) AS n FROM gt_prosp_optout WHERE value = ?`, [TEL]);
    check("dar de stop1 dos veces no duplica", num(optOuts[0].n) === 1);
    const hitSet = await O.optOutSet("phone", [TEL, "5511112222", null]);
    check("el cruce en batch encuentra sólo al dado de stop1", hitSet.size === 1 && hitSet.has(TEL));

    console.log("\n── Tope de intentos ──");
    check("Alfa lleva 1 envío", (await T.touchCount(rows[0].id, "email")) === 1);
    await T.markSent(t4!);
    check("Alfa lleva 2 envíos → tope alcanzado", (await T.touchCount(rows[0].id, "email")) === 2);

    console.log("\n── Cierre del loop: entra un WhatsApp ──");
    const m = await I.matchInbound(`52${TEL}`, "Hola, me interesa");
    check("cruza el número aunque venga con lada 52", m?.rowId === rows[0].id, m ? `→ ${m.business}` : "sin match");
    check("no lo lee como stop1", m?.isStopRequest === false);
    const unknown = await I.matchInbound("5200000000", "hola");
    check("un número ajeno NO cruza", unknown === null);
    const stop1 = await I.matchInbound(`52${TEL}`, "BAJA");
    check("«BAJA» sí se detecta", stop1?.isStopRequest === true);
    const stop2 = await I.matchInbound(`52${TEL}`, "no me interesa, gracias");
    check("«no me interesa» también", stop2?.isStopRequest === true);

    if (m) {
      await I.recordReply(m);
      check("la row pasó a replied", (await L.getRow(rows[0].id))?.status === "replied");
    }

    console.log("\n── Limpieza ──");
    await L.purgeList(listId);
    await dbq(`DELETE FROM gt_prosp_touches WHERE list_id = ?`, [listId]);
    await dbq(`DELETE FROM gt_prosp_optout WHERE value = ?`, [TEL]);
    const left = await dbq(`SELECT COUNT(*) AS n FROM gt_prosp_lists WHERE name = ?`, [MARCA]);
    check("no quedó basura", num(left[0].n) === 0);
  });

  console.log(`\n${failures ? `${failures} fallo(s).` : "Todo en verde."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("\n✗ reventó:", e);
  process.exit(1);
});
