// Ghosty Ads en el PANEL LATERAL (tipo nativo «campaign» de ArtifactPanel). No es un iframe
// de eb-artifact: son los mismos componentes React con las server fns de siempre, así que un
// agente no puede falsear los botones. Propuesta (vista previa grande, edición en línea,
// versiones, botones) y, ya creada, el embudo en vivo. Si @ads publicó un creativo en el
// hilo («Creativo · …»), va en su pestaña.
import { useCallback, useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { useT } from "../../i18n";
import { adsCreativeFn, adsProposalCardFn } from "../../server/apps/ads";
import { inMeta } from "../../server/apps/ads-flow";
import { campaignLink } from "../../lib/ads-links";
import { AdsProposalView } from "./AdsProposalCard";
import { AdsCampaignCard } from "./AdsCampaignCard";
import { AdsLiveEditor, AdsPlacements } from "./AdsLiveEditor";
import { useAdsCard } from "./useAdsCard";

type Tab = "proposal" | "placements" | "creative";

export function AdsCampaignPanel({ campaignId, channelId, version }: { campaignId: number; channelId: number; version?: number }) {
  const t = useT();
  const load = useCallback(() => adsProposalCardFn({ data: { campaignId } }), [campaignId]);
  const { st } = useAdsCard(load, channelId);
  const loadCreative = useCallback(() => adsCreativeFn({ data: { campaignId } }), [campaignId]);
  const { st: creative } = useAdsCard(loadCreative, channelId);
  const [tab, setTab] = useState<Tab>("proposal");
  const [copied, setCopied] = useState(false);
  if (!st) return <div className="m-4 h-40 animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none" />;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${campaignLink(st.roomSlug, st.rootMsgId, campaignId)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin portapapeles: no hay nada que hacer */
    }
  };

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${tab === id ? "bg-brand/12 text-brand" : "text-muted hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-1" role="tablist">
        {tabBtn("proposal", inMeta(st.status) ? t("Campaña") : t("Propuesta"))}
        {inMeta(st.status) && tabBtn("placements", t("Ubicaciones"))}
        {creative && tabBtn("creative", t("Creativo"))}
        <button
          type="button"
          onClick={copyLink}
          title={t("Copiar enlace")}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-ink"
        >
          {copied ? <Check size={14} className="text-brand" /> : <LinkIcon size={14} />} {copied ? t("¡Copiado!") : t("Copiar enlace")}
        </button>
      </div>
      {tab === "placements" && inMeta(st.status) ? (
        <AdsPlacements campaignId={campaignId} channelId={channelId} />
      ) : tab === "creative" && creative ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink">{creative.title}</p>
          <iframe
            title={creative.title}
            srcDoc={creative.html}
            sandbox="allow-scripts"
            className="h-[70vh] w-full rounded-md border border-border bg-white"
          />
          {creative.src && (
            <a href={creative.src} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
              {t("Abrir en pestaña nueva")} ↗
            </a>
          )}
        </div>
      ) : (
        <>
          {inMeta(st.status) ? (
            <>
              {/* Ya existe en Meta: embudo y [Prender]/[Pausar]/[Presupuesto]; abajo, lo que HOY
                  tiene Meta, editable como cambios pendientes. La propuesta original, plegada. */}
              <AdsCampaignCard card={{ campaignId }} channelId={channelId} />
              <AdsLiveEditor campaignId={campaignId} channelId={channelId} />
              {st.proposal.message && (
                <details className="rounded-lg border border-border px-3 py-2 text-xs">
                  <summary className="cursor-pointer text-muted">{t("Propuesta original")} (v{st.version})</summary>
                  <div className="mt-2">
                    <AdsProposalView campaignId={campaignId} channelId={channelId} initialVersion={version} layout="panel" />
                  </div>
                </details>
              )}
            </>
          ) : (
            <AdsProposalView key={`${campaignId}:${version ?? "v"}`} campaignId={campaignId} channelId={channelId} initialVersion={version} layout="panel" />
          )}
        </>
      )}
    </div>
  );
}
