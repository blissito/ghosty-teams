import { createFileRoute } from "@tanstack/react-router";

// POST /api/form-draft/<formToken> → guardar y continuar.
//
// Un intake patrimonial son 60+ preguntas: quien lo abandona a la mitad perdía todo. Esto lo
// guarda del lado del servidor y devuelve un enlace de reanudación.
//
// Misma familia que `api.form.$token.ts`: el token del PATH es el del formulario (transporta
// el namespace firmado, porque quien responde llega sin cookie y desde un iframe de origen
// opaco), CORS `*` sin credenciales, y todo lo que no resuelve responde 404 — nunca se
// confirma la existencia de un borrador a quien está probando tokens.
//
// El token del BORRADOR viaja en el cuerpo y, del lado del navegador, en el FRAGMENTO de la
// URL: el fragmento no llega al servidor, así que no entra en logs de acceso ni en el
// `Referer` de nada que la página cargue después.
//
// ⚠️ Esto es lo ÚNICO del formulario que abre escritura pública nueva, y lo que guarda es un
// intake a medio llenar. De ahí los tres topes de abajo, que el formulario de una sola
// respuesta no necesita, y que nazca apagado (`draft_ttl_days = 0`).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Borradores vivos por IP y por formulario. */
const MAX_PER_IP = 3;
/** Escrituras de UN borrador en toda su vida: el autosave es con debounce, no por tecla. */
const MAX_WRITES = 300;
/** Tamaño del payload guardado. Un intake de 60 campos con texto largo no llega a 64 KB. */
const MAX_BYTES = 256 * 1024;

export const Route = createFileRoute("/api/form-draft/$token")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      POST: async ({ params, request }: { params: { token: string }; request: Request }) => {
        const { verifyFormToken, verifyDraftToken, mintDraftToken } = await import(
          "../server/forms/token.server"
        );
        const ref = verifyFormToken(params.token);
        if (!ref) return json({ ok: false }, 404);

        let payload: { op?: string; draft?: string; data?: Record<string, string>; step?: number };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false }, 400);
        }

        const { withNamespace } = await import("../server/tenant.server");
        return withNamespace(ref.ns, async () => {
          const { ensureSchema } = await import("../server/schema.server");
          await ensureSchema();
          const { dbq, num } = await import("../dbq.server");
          const { getForm } = await import("../server/forms/publish.server");

          const form = await getForm(ref.id);
          if (!form || form.ns !== ref.ns) return json({ ok: false }, 404);
          // Apagado o cerrado: ni se lee ni se escribe. Un formulario que se cerró no debe
          // seguir sirviendo el intake a medias de nadie.
          if (form.draftTtlDays <= 0 || form.status === "closed") return json({ ok: false }, 404);

          const { clientIp, rateCheck } = await import("../server/forms/rate.server");
          const { ipHash, allowed } = await rateCheck(form.id, clientIp(request), {
            scope: "d",
            maxWithIp: 40,
            maxNoIp: 15,
          });
          if (!allowed) return json({ ok: false }, 429);

          const ttl = form.draftTtlDays * 86400;
          const ahora = Math.floor(Date.now() / 1000);

          // Poda oportunista, al estilo de gt_form_rate: sin cron y sin tabla que crezca sola.
          if (Math.random() < 0.05) {
            await dbq(`DELETE FROM gt_form_drafts WHERE expires_at < ?`, [ahora]).catch(() => []);
          }

          const ref2 = payload.draft ? verifyDraftToken(payload.draft) : null;
          // La firma manda, pero además tiene que ser de ESTE formulario y de este tenant:
          // un token legítimo de otro formulario no abre éste.
          const valido = ref2 && ref2.formId === form.id && ref2.ns === ref.ns ? ref2 : null;

          // ── Leer ──
          if (payload.op === "load") {
            if (!valido) return json({ ok: false }, 404);
            const rows = await dbq(
              `SELECT data_json, step FROM gt_form_drafts WHERE draft_id = ? AND form_id = ? AND expires_at > ?`,
              [valido.draftId, form.id, ahora]
            );
            // Vencido, borrado o firma de otro: todo responde igual.
            if (!rows[0]) return json({ ok: false }, 404);
            const { safeJson } = await import("../server/forms/submissions.server");
            return json({
              ok: true,
              data: safeJson<Record<string, string>>(rows[0].data_json, {}),
              step: num(rows[0].step),
            });
          }

          // ── Guardar ──
          const data = payload.data && typeof payload.data === "object" ? payload.data : {};
          const body = JSON.stringify(data);
          if (body.length > MAX_BYTES) return json({ ok: false }, 413);
          const step = Math.max(0, Math.min(200, Math.floor(Number(payload.step ?? 0)) || 0));
          const expires = ahora + ttl;

          if (valido) {
            // `writes` es el tope de vida del borrador y se comprueba en el WHERE: pasado el
            // límite el UPDATE no toca nada y lo guardado se queda como estaba, que es mejor
            // que borrarlo o que dejarlo escribir sin fin.
            await dbq(
              `UPDATE gt_form_drafts
                  SET data_json = ?, step = ?, writes = writes + 1, updated_at = ?, expires_at = ?
                WHERE draft_id = ? AND form_id = ? AND writes < ?`,
              [body, step, ahora, expires, valido.draftId, form.id, MAX_WRITES]
            );
            return json({ ok: true, draft: payload.draft, expiresAt: expires });
          }

          // Nuevo. El tope por IP es lo que impide llenar la tabla desde una sola máquina;
          // sin IP legible no se crea ninguno — es escritura pública, no un submit que vale
          // la pena dejar pasar ante un proxy raro.
          if (!ipHash) return json({ ok: false }, 404);
          const vivos = await dbq(
            `SELECT COUNT(*) AS n FROM gt_form_drafts WHERE form_id = ? AND ip_hash = ? AND expires_at > ?`,
            [form.id, ipHash, ahora]
          );
          if (num(vivos[0]?.n) >= MAX_PER_IP) return json({ ok: false }, 429);

          const { randomUUID } = await import("node:crypto");
          const draftId = randomUUID();
          await dbq(
            `INSERT INTO gt_form_drafts (draft_id, form_id, ip_hash, data_json, step, writes, expires_at)
             VALUES (?,?,?,?,?,1,?)`,
            [draftId, form.id, ipHash, body, step, expires]
          );
          return json({
            ok: true,
            draft: mintDraftToken({ draftId, formId: form.id, ns: ref.ns }, ttl),
            expiresAt: expires,
          });
        });
      },
    },
  },
});
