import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { ChevronUp, Check } from "lucide-react";
import { useT } from "../../i18n";
import { rememberDevice } from "../../lib/call-store";

type Kind = "audioinput" | "videoinput";

// Chevron pegado al botón de mic/cámara que abre la lista de dispositivos. Se enumera al
// ABRIR (el mic ya está encendido, así que el navegador da nombres reales) y se vuelve a
// enumerar cuando conectan o quitan un USB (`devicechange`), cosa que la sala del
// webinar no hace. El cambio va por `room.switchActiveDevice`, que republica solo.
export function DevicePicker({ room, kind }: { room: Room; kind: Kind }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  const [active, setActive] = useState<string>("");
  const wrap = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevs(all.filter((d) => d.kind === kind));
      setActive(room.getActiveDevice(kind) ?? "");
    } catch {
      setDevs([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onChange = () => void refresh();
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    document.addEventListener("mousedown", onDoc);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
      document.removeEventListener("mousedown", onDoc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const pick = async (id: string) => {
    setOpen(false);
    try {
      await room.switchActiveDevice(kind, id);
      rememberDevice(kind, id);
    } catch {
      /* el dispositivo desapareció entre enumerar y elegir: la lista se refresca al abrir */
    }
  };

  const title = kind === "audioinput" ? t("Elegir micrófono") : t("Elegir cámara");
  return (
    <div ref={wrap} className="relative -ml-1.5 self-stretch">
      <button
        type="button"
        aria-label={title}
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className="grid h-10 w-5 place-items-center rounded-full text-muted transition hover:bg-surface-3 hover:text-ink"
      >
        <ChevronUp size={13} />
      </button>
      {open ? (
        <div className="absolute bottom-11 left-0 z-[60] flex min-w-[14rem] max-w-[18rem] flex-col gap-0.5 rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</div>
          {devs.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted">{t("No encontré dispositivos")}</div>
          ) : (
            devs.map((d, i) => (
              <button
                key={d.deviceId || i}
                type="button"
                onClick={() => pick(d.deviceId)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink transition hover:bg-surface-3"
              >
                <span className="w-3.5 shrink-0">{d.deviceId === active ? <Check size={14} /> : null}</span>
                <span className="truncate">{d.label || t("Dispositivo {n}").replace("{n}", String(i + 1))}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
