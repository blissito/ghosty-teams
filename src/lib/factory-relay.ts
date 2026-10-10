// La estafeta del pedido a escala de tiempo: cuánto tuvo el pedido cada rol y cuánto lleva
// esperando a la persona. Sale de la bitácora (gt_factory_events), no de lo que diga un rol.

export type Holder = "plan" | "you" | "build" | "check";
export type RelaySegment = { who: Holder; seconds: number };

// Quién tiene el pedido DESPUÉS de cada evento. Los que no están aquí no lo cambian de manos.
const AFTER: Record<string, Holder | null> = {
  plan_submitted: "you",
  approve: "build",
  changes: "plan",
  build_done: "check",
  check_fail: "build",
  ci_red: "build",
  conflict: "build",
  rework: "build",
  check_blocked: "you",
  check_pass: "you",
  merged: null,
  close: null,
  cancel: null,
};

/** Eventos en cualquier orden (`at` en segundos). Junta los tramos seguidos del mismo rol. */
export function relaySegments(events: { at: number; type: string }[], nowSec: number): RelaySegment[] {
  const ev = [...events].sort((a, b) => a.at - b.at);
  if (!ev.length) return [];
  const out: RelaySegment[] = [];
  let who: Holder | null = "plan";
  let from = ev[0].at;
  const push = (to: number) => {
    if (!who || to <= from) return;
    const last = out[out.length - 1];
    if (last && last.who === who) last.seconds += to - from;
    else out.push({ who, seconds: to - from });
  };
  for (const e of ev) {
    if (!(e.type in AFTER)) continue;
    push(e.at);
    who = AFTER[e.type];
    from = e.at;
  }
  push(nowSec);
  return out;
}

/** «4m», «1h 20m», «2d 3h». */
export function shortDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.max(1, Math.round(sec))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
