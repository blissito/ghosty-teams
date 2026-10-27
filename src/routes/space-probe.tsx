import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ModuleChips, PayButton, SpaceCard, SpaceClosedScreen, TrialStripView, type SpaceStatus } from "../components/SpacePlan";

// Banco de la pantalla «Space cerrado» y de la franja de días — SÓLO en desarrollo (el
// guard de __root lo exime ahí y nada más). Mismo espíritu que /brand-probe: ajustar el
// diseño sin un espacio vencido de verdad.
//
// ?view=owner|born|member|strip|plan · &offer=1 · ?theme=light|dark

export const Route = createFileRoute("/space-probe")({
  component: SpaceProbe,
});

// Oferta de muestra: el 7-nov a medianoche de CDMX.
const OFFER = { percent: 50, firstMonth: 345, until: "2026-11-08T06:00:00.000Z" };

const DEMO: SpaceStatus = {
  slug: "iaconnecting",
  plan: "trial",
  isTrial: true,
  trialEndsAt: "2026-10-31T06:00:00.000Z",
  trialExpired: true,
  daysLeft: 0,
  payUrl: "https://www.ghosty.studio/app/workspaces/iaconnecting/plan?return=https%3A%2F%2Fiaconnecting.teams.ghosty.studio%2F",
  checkoutUrl: "https://www.ghosty.studio/app/workspaces/iaconnecting/plan?return=https%3A%2F%2Fiaconnecting.teams.ghosty.studio%2F&checkout=1",
  studioUrl: "https://www.ghosty.studio",
};

function SpaceProbe() {
  const [view, setView] = useState("owner");
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setView(q.get("view") ?? "owner");
    setOffer(q.get("offer") === "1");
    const theme = q.get("theme");
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }, []);
  const status: SpaceStatus = offer ? { ...DEMO, offer: OFFER } : DEMO;
  if (view === "born") return <SpaceClosedScreen status={{ ...status, bornClosed: true }} isOwner />;
  if (view === "member") return <SpaceClosedScreen status={status} isOwner={false} />;
  if (view === "strip")
    return (
      <div className="min-h-[100dvh] bg-surface text-ink">
        <header className="flex h-14 items-center border-b border-border px-4 font-semibold"># general</header>
        <TrialStripView status={{ ...status, trialExpired: false }} days={5} onHide={() => {}} />
        <div className="p-6 text-sm text-muted">…mensajes del room…</div>
      </div>
    );
  if (view === "plan")
    return (
      <div className="min-h-[100dvh] bg-surface-2 p-4 text-ink sm:p-8">
        <div className="mx-auto max-w-md space-y-6">
          <div className="mx-auto max-w-md">
            <SpaceCard offer={status.offer} cta={<PayButton status={status} label="Elegir plan" />} />
          </div>
          <ModuleChips />
        </div>
      </div>
    );
  return <SpaceClosedScreen status={status} isOwner />;
}
