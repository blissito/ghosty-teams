import { Suspense, lazy, useLayoutEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { Headphones, Maximize2, Minimize2 } from "lucide-react";
import { useT } from "../i18n";

// Lazy: livekit-client toca APIs del browser al importar → sólo se carga en cliente,
// cuando hay una llamada abierta (mantiene el SSR de cualquier ruta a salvo).
const QuickCall = lazy(() => import("./QuickCall").then((m) => ({ default: m.QuickCall })));

// Dock flotante nativo: renderiza <QuickCall> (livekit-client) con los tokens de
// Teams → hereda light/dark. Header = título + expandir; salir vive en QuickCall.
// Nace ARRIBA-DERECHA y se monta en la raíz, así que sobrevive a la navegación.
export function QuickCallDock({ room, label }: { room: Room; label: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null = anclado arriba-derecha
  const [size, setSize] = useState<{ w: number; h: number } | null>(null); // null = tamaño default
  const [hasVideo, setHasVideo] = useState(false); // solo-audio → dock compacto (mínimo)
  const dockRef = useRef<HTMLDivElement>(null);
  const positioned = !!pos && !expanded;
  const sized = !!size && !expanded;
  // Solo-audio y sin tamaño manual ni expandido → ventana mínima (avatares + controles).
  const compact = !hasVideo && !expanded && !sized;

  // Al CRECER (compact→grande cuando alguien comparte/prende cámara) el dock arrastrado
  // conservaba su top-left → se salía del viewport. Tras cada cambio de tamaño (compact/
  // hasVideo/expanded), re-clampa la posición guardada para que la ventana quepa completa.
  useLayoutEffect(() => {
    if (!pos || expanded) return;
    const el = dockRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(pos.x, window.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(pos.y, window.innerHeight - r.height - 4));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, hasVideo, expanded]);

  // Arrastra el dock por su barra (solo acoplado). Se clampa al viewport.
  const startDrag = (e: React.PointerEvent) => {
    if (expanded || (e.target as HTMLElement).closest("button")) return;
    const el = dockRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, ev.clientX - dx));
      const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, ev.clientY - dy));
      setPos({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Redimensiona por la esquina inf-derecha. Ancla arriba-izquierda (fija pos) para
  // crecer hacia abajo-derecha con el cursor; clampado al viewport.
  const startResize = (e: React.PointerEvent) => {
    if (expanded) return;
    e.stopPropagation();
    const el = dockRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left, y: r.top });
    const sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height, left = r.left, top = r.top;
    const move = (ev: PointerEvent) => {
      const w = Math.max(320, Math.min(window.innerWidth - left - 4, sw + (ev.clientX - sx)));
      const h = Math.max(240, Math.min(window.innerHeight - top - 4, sh + (ev.clientY - sy)));
      setSize({ w, h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const style =
    !expanded && (positioned || sized)
      ? { ...(positioned ? { left: pos!.x, top: pos!.y } : {}), ...(sized ? { width: size!.w, height: size!.h } : {}) }
      : undefined;

  return (
    <div
      ref={dockRef}
      style={style}
      className={
        (expanded
          ? "fixed inset-3 md:inset-6"
          : compact
            ? "fixed h-64 w-[min(340px,92vw)]" + (positioned ? "" : " right-4 top-4")
            : "fixed h-[min(80vh,720px)] w-[min(960px,94vw)]" + (positioned || sized ? "" : " right-4 top-4")) +
        // bg-surface-2 (como el sidebar) + borde brand → NO se funde con el chat (bg-surface)
        // en claro NI oscuro; antes era bg-surface con borde ink tenue y se perdía.
        " z-50 flex flex-col overflow-hidden rounded-xl border-2 border-brand/40 bg-surface-2 shadow-2xl ring-1 ring-black/10"
      }
    >
      <div
        onPointerDown={startDrag}
        className={"flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-2" + (expanded ? "" : " cursor-move select-none")}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Headphones size={15} className="shrink-0 text-brand" />
          {/* El título dice DÓNDE es la llamada (#canal o con quién), no la palabra
              "Llamada": el dock flota sobre toda la app y ése es el único dato que no se
              puede deducir mirándolo. Que es una llamada ya lo dicen el ícono y los
              controles. */}
          <span className="truncate text-sm font-semibold text-ink" title={t("Llamada")}>{label}</span>
        </div>
        <button
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? t("Restaurar") : t("Expandir")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-3 hover:text-ink"
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-muted">{t("Conectando…")}</div>}>
        <QuickCall room={room} onVideoChange={setHasVideo} />
      </Suspense>
      {!expanded && (
        <div
          onPointerDown={startResize}
          title={t("Arrastra para redimensionar")}
          className="absolute bottom-0 right-0 z-20 grid size-6 cursor-nwse-resize place-items-center rounded-tl-md text-ink/60 transition hover:bg-surface-3 hover:text-brand"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M12 4 L4 12 M12 8.5 L8.5 12" />
          </svg>
        </div>
      )}
    </div>
  );
}
