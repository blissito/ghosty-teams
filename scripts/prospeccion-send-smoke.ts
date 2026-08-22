/**
 * Smoke del camino de ENVÍO: el plan, el renderizado y los guards.
 * Uso: npx tsx --env-file=.env scripts/prospeccion-send-smoke.ts
 *
 * NO manda ni un correo: `planSend` calcula sin enviar y `renderDraft` sólo compone.
 * Lo que se prueba es que el número que enseña la pantalla sea el que de verdad saldría.
 */
import { withNamespace } from "../src/server/tenant.server";

let f = 0;
const check = (l: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`);
  if (!ok) f++;
};

await withNamespace(process.env.SQLD_NAMESPACE ?? "default", async () => {
  const { renderDraft } = await import("../src/server/prospeccion/send.server");
  const { planSend } = await import("../src/server/prospeccion/send.server");
  const { addOptOut, removeOptOut, listOptOuts } = await import("../src/server/prospeccion/optout.server");

  console.log("\n── El sobre ──");
  const conWa = await renderDraft({ subject: "Hola", body: "Prueba", businessName: "Salón X", waPhone: "527714460521" });
  check("mete el botón de WhatsApp", conWa.html.includes("wa.me/527714460521"));
  // ⚠️ Se decodifica SÓLO la URL, no el HTML entero: los `%` del CSS (`width:100%`) hacen
  // que `decodeURIComponent` reviente con «URI malformed».
  const urlWa = conWa.html.match(/https:\/\/wa\.me\/[^"']+/)?.[0] ?? "";
  check("prellena el mensaje con el negocio", decodeURIComponent(urlWa).includes("soy de Salón X"));
  const malicioso = await renderDraft({ subject: "x", body: "<script>alert(1)</script>", waPhone: "527714460521" });
  check("escapa el cuerpo escrito por el modelo", !/<script/i.test(malicioso.html), "acaba en el correo de un tercero");

  const sinWa = await renderDraft({ subject: "Hola", body: "Prueba", waPhone: null });
  check("SIN número lo REPORTA en vez de callar", sinWa.sinBoton === true, "un correo sin botón no cierra el loop");
  check("y no deja marcadores crudos", !sinWa.html.includes("%%WA%%"));
  check("el botón es un ENLACE, no texto escapado", conWa.html.includes('href="https://wa.me/'), "⚠️ ghostyEmail escapa el body: el cta va aparte");

  console.log("\n── El plan cuenta lo que de verdad saldría ──");
  const filas = [
    { id: 1, email: "vivo@gmail.com", name: "A", data: {}, status: "new" },
    { id: 2, email: "", name: "B", data: {}, status: "new" },
    { id: 3, email: "baja@gmail.com", name: "C", data: {}, status: "new" },
    { id: 4, email: "muerto@x.mx", name: "D", data: { c: { v: "no recibe correo", src: "correo_sirve" } }, status: "new" },
  ] as never[];

  await addOptOut("email", "baja@gmail.com", "manual");
  const plan = await planSend({ listId: 0, campaign: "smoke", rows: filas });

  check("total = las 4 de la vista", plan.total === 4);
  check("sin correo: 1", plan.sinCorreo === 1);
  check("dado de baja: 1", plan.optOut === 1, "⚠️ el invariante que protege el dominio");
  check("correo muerto: 1", plan.correoMuerto === 1, "el verificador ya dijo que rebota");
  check("IRÍAN de verdad: 1", plan.irian === 1, `«Mandar a 4» habría sido mentira`);
  check("la muestra enseña a quién", plan.muestra[0]?.email === "vivo@gmail.com");

  // Limpieza: la baja era de prueba.
  const bajas = await listOptOuts(200);
  for (const b of bajas.filter((x) => x.value === "baja@gmail.com")) await removeOptOut(b.id);
  console.log(`\n${f ? `${f} fallo(s).` : "Todo en verde."}\n`);
});
process.exit(f ? 1 : 0);
