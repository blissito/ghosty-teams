import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Lock, Megaphone, PenLine, Send, TestTube2 } from "lucide-react";
import { useT } from "../../i18n";
import { getCampaignFn } from "../../server/prospeccion";
import { nextStep } from "../../lib/prospeccion-campaign";
import { CtaSetting, SenderSetting, WaSetting } from "./SenderSetting";

type Campaign = NonNullable<Awaited<ReturnType<typeof getCampaignFn>>>;

/**
 * La campaña, siempre a la vista: de quién sale, a qué WhatsApp escriben, cómo cierra el
 * correo, y UN botón con lo que sigue.
 *
 * Antes la configuración vivía en el índice (para todo el espacio) y dentro del modal de
 * enviar: había que abrir «Enviar» para descubrir que el botón llevaba al número de otra
 * campaña. Aquí cada cosa se edita en su lugar y el botón dice el siguiente paso real
 * —configurar, escribir el mensaje, mandarse una prueba o enviar—, como el «launch
 * checklist» de lemlist pero en una línea.
 */
export function CampaignBar({
  listId,
  shown,
  hasMessageColumn,
  sent,
  refreshKey,
  onWriteMessage,
  onReview,
}: {
  listId: number;
  /** Filas a la vista: a quienes saldría. */
  shown: number;
  /** Hay alguna columna de mensaje escrita por el agente. */
  hasMessageColumn: boolean;
  /** Correos ya enviados de esta lista. */
  sent: number;
  /** Cambia cuando algo de fuera (el agente, una prueba) pudo mover el estado. */
  refreshKey?: unknown;
  onWriteMessage: () => void;
  /** Abre «Antes de enviar» (previsualización, prueba y envío). */
  onReview: () => void;
}) {
  const t = useT();
  const [c, setC] = useState<Campaign | null>(null);
  const load = useCallback(() => {
    getCampaignFn({ data: { listId } }).then((r) => { if (r) setC(r); }).catch(() => {});
  }, [listId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (!c) return <div className="shrink-0 h-[42px] border-b border-border" />;

  const step = nextStep({
    ctaKind: c.cta.kind,
    waPhone: c.waPhone,
    senderName: c.senderName,
    hasMessage: c.hasBase || hasMessageColumn,
    testSent: !!c.testSentAt,
    shown,
  });

  const cta =
    step.id === "setup"
      ? { label: step.missing.includes("whatsapp") ? t("Pon el WhatsApp de la campaña") : t("Pon quién firma"), icon: PenLine, run: null }
      : step.id === "message"
        ? { label: t("Escribir el mensaje"), icon: PenLine, run: onWriteMessage }
        : step.id === "test"
          ? { label: t("Mándate una prueba"), icon: TestTube2, run: onReview }
          : step.id === "send"
            ? { label: `${t("Enviar a")} ${step.n.toLocaleString("es-MX")}`, icon: Send, run: onReview }
            : { label: t("No hay filas a la vista"), icon: ArrowRight, run: null };

  return (
    <div className="shrink-0 border-b border-border px-5 py-1.5 flex items-center gap-x-4 gap-y-1 flex-wrap bg-surface-2/40">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
        <Megaphone size={12} />
        {t("Campaña")}
        {sent ? (
          <span className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px]" title={t("Ya salió: su configuración quedó fija y cambiar la del espacio no la mueve")}>
            <Lock size={10} /> {t("enviada")} · {sent.toLocaleString("es-MX")}
          </span>
        ) : null}
      </span>
      {/* Las mismas piezas que el índice, con el alcance de ESTA lista. Sin margen propio: aquí van en línea. */}
      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap [&>div]:mt-0">
        <WaSetting listId={listId} onSaved={load} />
        <SenderSetting listId={listId} onSaved={load} />
        <CtaSetting listId={listId} onSaved={load} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        {step.id === "setup" ? (
          <span className="text-xs text-amber-500">{cta.label}</span>
        ) : cta.run ? (
          <button
            onClick={cta.run}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              step.id === "send" ? "bg-brand text-brand-fg hover:brightness-110" : "border border-brand text-brand hover:bg-brand/10"
            }`}
          >
            <cta.icon size={13} />
            {cta.label}
          </button>
        ) : (
          <span className="text-xs text-muted">{cta.label}</span>
        )}
      </div>
    </div>
  );
}
