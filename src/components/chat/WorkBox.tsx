// La caja de trabajo del pedido, como maquinita debajo del avatar del agente que la usa en el hilo
// (bliss, 12-oct: «Levantando una caja de trabajo · 2 min» no decía nada de la caja). Es la misma
// cabeza de terminal que gs pinta en sus cajas (`SpaceBoxes`): pantalla verde = trabajando,
// dormida, encendiendo, en error. Se pregunta al montar y cada 15 s mientras está a la vista.
import { useEffect, useState, useSyncExternalStore } from "react";
import { BoxDetail, RobotHead, lookFor, type BoxTone, type RobotHeadState } from "@ghostystudio/boxes/react";
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
  const [open, setOpen] = useState(false);
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
  const detail = open && <WorkBoxDetail box={box} look={look} onClose={() => setOpen(false)} />;
  // Sin lugar todavía: el hueco vacío, la misma cajita blanca apagada de los «libre» de gs (bliss, 13-oct).
  if (box.state === "waiting")
    return (
      <>
      {detail}
      <button type="button" onClick={() => setOpen(true)} title={title} aria-label={title} className="inline-block shrink-0 cursor-pointer" style={{ width: 28, height: 28 }}>
        <RobotHead
          size={28}
          shape={box.look?.shape ?? "circle"}
          state="idle"
          color="#e4e4e7"
          trimColor="#c4c4cc"
          face="off"
          antenna={false}
          floorShadow={false}
          paused
          interactive={false}
        />
      </button>
      </>
    );
  return (
    <>
    {detail}
    <button type="button" onClick={() => setOpen(true)} title={title} aria-label={title} className="inline-block shrink-0 cursor-pointer" style={{ width: 28, height: 28 }}>
      <RobotHead
        size={28}
        face="terminal"
        screenIcon="build"
        shape={box.look?.shape ?? "circle"}
        color={box.state === "error" ? "#c62828" : box.look?.color ?? "#1f8189"}
        screenColor={look.screen}
        state={look.state}
        seed={lookFor(box.boxId ?? String(box.runId)).seed}
        antenna={false}
        floorShadow={false}
        interactive
        speed={box.state === "asleep" ? 0.6 : 1}
      />
    </button>
    </>
  );
}

const TONE: Record<ThreadBox["state"], BoxTone> = { waiting: "sleep", starting: "calm", on: "calm", asleep: "sleep", error: "error", off: "calm" };

function ago(iso: string | null | undefined, t: ReturnType<typeof useT>): string | null {
  if (!iso) return null;
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return t("ahora");
  if (min < 60) return t("hace {n} min", { n: min });
  const h = Math.round(min / 60);
  return h < 48 ? t("hace {n} h", { n: h }) : t("hace {n} días", { n: Math.round(h / 24) });
}

/** La ficha de la caja: el mismo modal de /cajas en gs (`BoxDetail` del paquete). */
function WorkBoxDetail({ box, look, onClose }: { box: ThreadBox; look: { state: RobotHeadState; screen: string; label: string }; onClose: () => void }) {
  const t = useT();
  const tone: BoxTone = box.working && box.state === "on" ? "work" : TONE[box.state];
  const rows = [
    box.title ? { label: t("Pedido"), value: `#${box.runId} · ${box.title}` } : { label: t("Pedido"), value: `#${box.runId}` },
    box.runStatus ? { label: t("Paso"), value: box.runStatus } : null,
    box.createdAt ? { label: t("Encendida"), value: ago(box.createdAt, t) } : null,
    box.state === "asleep" && box.suspendedAt ? { label: t("Duerme desde"), value: ago(box.suspendedAt, t) } : null,
    box.lastActiveAt ? { label: t("Última actividad"), value: ago(box.lastActiveAt, t) } : null,
    box.memoryMb ? { label: t("Memoria"), value: `${(box.memoryMb / 1024).toFixed(box.memoryMb % 1024 ? 1 : 0)} GB` } : null,
  ].filter((r): r is { label: string; value: string } => !!r && !!r.value);
  return (
    <BoxDetail
      light
      onClose={onClose}
      closeLabel={t("Cerrar")}
      data={{
        name: box.label ?? `${t("Pedido")} #${box.runId}`,
        idLabel: box.boxId ? box.boxId.slice(0, 11) : undefined,
        title: t("Caja de trabajo del pedido"),
        state: { label: t(look.label) || t("sin caja"), tone },
        hint:
          box.state === "waiting"
            ? t("Espera un lugar libre del plan; arranca sola en cuanto se desocupe uno.")
            : box.working
              ? t("La fábrica está trabajando en el pedido.")
              : box.state === "asleep"
                ? t("Duerme mientras nadie la usa; despierta sola en el siguiente paso.")
                : undefined,
        head: {
          face: box.state === "waiting" ? "off" : "terminal",
          screenIcon: "build",
          shape: box.look?.shape ?? "circle",
          color: box.state === "waiting" ? "#e4e4e7" : box.state === "error" ? "#c62828" : box.look?.color ?? "#1f8189",
          screenColor: look.screen,
          state: box.state === "waiting" ? "idle" : look.state,
          seed: lookFor(box.boxId ?? String(box.runId)).seed,
          antenna: false,
        },
        rows,
      }}
    />
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
