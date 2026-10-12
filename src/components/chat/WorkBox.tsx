// La caja de trabajo del pedido, como maquinita debajo del avatar del agente que la usa en el hilo
// (bliss, 12-oct: «Levantando una caja de trabajo · 2 min» no decía nada de la caja). Es la misma
// cabeza de terminal que gs pinta en sus cajas (`SpaceBoxes`): pantalla verde = trabajando,
// dormida, encendiendo, en error. Se pregunta al montar y cada 15 s mientras está a la vista.
import { useEffect, useState, useSyncExternalStore } from "react";
import { RobotHead, lookFor, type RobotHeadState } from "@ghostystudio/boxes/react";
import { factoryThreadBoxFn, type ThreadBox } from "../../server/apps/factory";
import { useT } from "../../i18n";

const LOOK: Record<ThreadBox["state"], { state: RobotHeadState; screen: string; label: string }> = {
  waiting: { state: "sleeping", screen: "#e8f2ff", label: "en espera de lugar" },
  starting: { state: "thinking", screen: "#e8f2ff", label: "encendiendo" },
  on: { state: "idle", screen: "#e8f2ff", label: "despierta" },
  asleep: { state: "sleeping", screen: "#e8f2ff", label: "dormida" },
  error: { state: "error", screen: "#ff6b6b", label: "con error" },
  off: { state: "idle", screen: "#e8f2ff", label: "" },
};

export function WorkBox({ channelId, parentId, live }: { channelId: number; parentId: number; live: boolean }) {
  const t = useT();
  const [box, setBox] = useState<ThreadBox | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      factoryThreadBoxFn({ data: { channelId, parentId } })
        .then((b) => alive && setBox(b))
        .catch(() => {});
    load();
    // Con el turno corriendo cambia rápido (enciende, trabaja); sin turno, basta de vez en cuando.
    const id = setInterval(load, live ? 15_000 : 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [channelId, parentId, live]);
  if (!box || box.state === "off") return null;
  const look = box.working && box.state === "on" ? { state: "working" as const, screen: "#7dff9a", label: "trabajando" } : LOOK[box.state];
  const title = `${t("Caja de trabajo del pedido")} #${box.runId} · ${t(look.label)}${box.label ? `\n${box.label}` : ""}`;
  return (
    <span title={title} aria-label={title} className="inline-block shrink-0" style={{ width: 28, height: 28 }}>
      <RobotHead
        size={28}
        face="terminal"
        screenIcon="build"
        shape="circle"
        color={box.state === "error" ? "#c62828" : "#1f8189"}
        screenColor={look.screen}
        state={look.state}
        seed={lookFor(box.boxId ?? String(box.runId)).seed}
        antenna={false}
        floorShadow={false}
        interactive={false}
        speed={box.state === "asleep" || box.state === "waiting" ? 0.6 : 1}
      />
    </span>
  );
}

// ── Una sola maquinita por hilo: la lleva la burbuja de agente más reciente ─────────────────
// Cada burbuja candidata se registra con su hilo y su id; sólo la de id mayor la pinta.
const mounted = new Map<number, Map<number, number>>(); // hilo → id → montajes
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const latestOf = (thread: number) => {
  const ids = mounted.get(thread);
  return ids && ids.size ? Math.max(...ids.keys()) : -1;
};

/** ¿Es `id` la burbuja de agente más reciente en pantalla del hilo `thread`? (null = no participa) */
export function useIsLatestInThread(thread: number | null, id: number): boolean {
  useEffect(() => {
    if (thread == null) return;
    const ids = mounted.get(thread) ?? new Map<number, number>();
    mounted.set(thread, ids);
    ids.set(id, (ids.get(id) ?? 0) + 1);
    emit();
    return () => {
      const n = (ids.get(id) ?? 1) - 1;
      if (n > 0) ids.set(id, n);
      else ids.delete(id);
      emit();
    };
  }, [thread, id]);
  return useSyncExternalStore(subscribe, () => thread != null && latestOf(thread) === id, () => false);
}
