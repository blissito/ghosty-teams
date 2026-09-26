// La línea «✏️ … → vN» que publica la plataforma al guardar una versión de una propuesta de
// Ghosty Ads, como link: abre el panel lateral en ESA versión. Las líneas viejas no traen el
// #N y la campaña se resuelve por su hilo.
import { useState } from "react";
import { adsThreadCampaignFn } from "../../server/apps/ads";
import type { VersionLine } from "../../lib/ads-links";
import type { ArtifactView } from "../ArtifactPanel";

export function AdsVersionLink({
  line,
  channelId,
  rootId,
  onOpen,
}: {
  line: VersionLine;
  channelId: number;
  rootId: number;
  onOpen?: (a: ArtifactView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (!onOpen || busy) return;
    let id = line.campaignId;
    if (id == null) {
      setBusy(true);
      id = await adsThreadCampaignFn({ data: { channelId, rootId } }).catch(() => null);
      setBusy(false);
    }
    if (id != null) onOpen({ kind: "campaign", title: `#${id}`, campaignId: id, channelId, version: line.version });
  };
  return (
    <button type="button" onClick={open} disabled={!onOpen} className="text-left text-sm text-ink hover:underline disabled:no-underline">
      ✏️ {line.text} → <span className="font-semibold text-brand">v{line.version}</span>
    </button>
  );
}
