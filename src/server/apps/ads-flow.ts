// Máquina de estados de una campaña de Ghosty Ads. Pura (sin DB) para probarla.
//
//   proposal ──create──▶ creating ──created──▶ paused ⇄ active ──end──▶ ended
//      │                    └──create_failed──▶ error ──retry──▶ proposal
//      └──cancel──▶ cancelled                    └──cancel──▶ cancelled
//
// El agente sólo llega a `proposal`. Todo lo que gasta (crear en pausa, prender, cambiar
// presupuesto) es un botón de una tarjeta que pica una PERSONA; pausar también, aunque no
// gaste, para que el historial diga quién lo hizo.

export type AdsStatus = "proposal" | "creating" | "paused" | "active" | "ended" | "cancelled" | "error";

export type AdsEvent = "create" | "created" | "create_failed" | "activate" | "pause" | "budget" | "end" | "cancel" | "retry";

export const ADS_STATUSES: AdsStatus[] = ["proposal", "creating", "paused", "active", "ended", "cancelled", "error"];

/** El estado siguiente, o null si el evento no aplica en este estado. */
export function nextAdsStatus(status: AdsStatus, event: AdsEvent): AdsStatus | null {
  switch (status) {
    case "proposal":
      if (event === "create") return "creating";
      if (event === "cancel") return "cancelled";
      return null;
    case "creating":
      if (event === "created") return "paused";
      if (event === "create_failed") return "error";
      return null;
    case "paused":
      if (event === "activate") return "active";
      if (event === "budget") return "paused";
      if (event === "end") return "ended";
      return null;
    case "active":
      if (event === "pause") return "paused";
      if (event === "budget") return "active";
      if (event === "end") return "ended";
      return null;
    case "error":
      if (event === "retry") return "proposal";
      if (event === "cancel") return "cancelled";
      return null;
    default:
      return null;
  }
}

export type AdsPlatform = "meta" | "google";

/** Etiqueta visible del estado. «Creando en…» dice en qué plataforma. */
export function adsStatusLabel(status: AdsStatus | string, platform: AdsPlatform | string = "meta"): string {
  return (
    {
      proposal: "Propuesta",
      creating: platform === "google" ? "Creando en Google…" : "Creando en Meta…",
      paused: "En pausa",
      active: "Activa",
      ended: "Terminada",
      cancelled: "Cancelada",
      error: "Error",
    } as Record<string, string>
  )[status] ?? status;
}

/** ¿La campaña ya existe en su plataforma? (tiene ids y se le pueden pedir números). */
export function isLive(status: AdsStatus | string): boolean {
  return status === "paused" || status === "active" || status === "ended";
}

/** ¿Existe en META? (embudo de Messenger, ubicaciones, revisión, cambios pendientes). */
export function inMeta(status: AdsStatus | string, platform: AdsPlatform | string = "meta"): boolean {
  return platform !== "google" && isLive(status);
}
