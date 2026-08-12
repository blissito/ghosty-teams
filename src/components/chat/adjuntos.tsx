import { useCallback, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { useT } from "../../i18n";

// Adjuntar archivos: arrastrar, soltar, y subir.
//
// Vivía dentro de `routes/c.$slug.tsx`. Salió cuando el room abierto también necesitó
// adjuntos: la alternativa era escribir una segunda subida, y una segunda subida es la que
// se queda sin el `previewUrl` instantáneo, sin el reintento del foco y sin liberar los
// objectURL — los tres detalles que costaron y que no se ven hasta que faltan.

/** Un archivo en vuelo: se pinta ANTES de que termine de subir. */
export type Pendiente = {
  localId: string;
  name: string;
  mime: string;
  size: number;
  fileId?: string;
  thumbFileId?: string | null;
  width?: number | null;
  height?: number | null;
  /** Firma que ata el archivo a quien lo subió y a su room (sólo invitados). */
  pass?: string;
  uploading: boolean;
  error?: boolean;
  /** objectURL local → miniatura instantánea, sin esperar al servidor. */
  previewUrl?: string;
};

/**
 * Zona de arrastre. Cuenta `dragenter`/`dragleave` porque los hijos disparan los suyos:
 * sin el contador, pasar el cursor por encima de un mensaje apagaba el overlay a media
 * operación.
 */
export function useFileDrop(onFiles: (files: FileList | File[]) => void, onDropped?: () => void) {
  const [dragOver, setDragOver] = useState(false);
  const counter = useRef(0);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      counter.current += 1;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      counter.current -= 1;
      if (counter.current <= 0) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      counter.current = 0;
      setDragOver(false);
      if (e.dataTransfer.files?.length) {
        onFiles(e.dataTransfer.files);
        // El foco se pide TAMBIÉN aquí, dentro del handler del gesto: desde el evento el
        // navegador es más permisivo con un `focus()` programático que desde un callback.
        onDropped?.();
      }
    },
  };
  return { dragOver, handlers };
}

/** El "suelta aquí" que cubre la conversación. El contenedor padre debe ser `relative`. */
export function DropOverlay({ show }: { show: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 border-[3px] border-dashed border-brand bg-surface/85 backdrop-blur-sm">
      <div className="grid size-16 place-items-center rounded-2xl bg-brand/15 text-brand">
        <ImagePlus size={32} />
      </div>
      <p className="text-lg font-semibold text-brand">{t("Suelta para enviar")}</p>
      <p className="text-sm text-muted">{t("Imágenes y archivos")}</p>
    </div>
  );
}

/**
 * La subida. Cada archivo sale hacia `/api/upload` en cuanto se elige o se suelta, no al
 * enviar el mensaje: así el envío es instantáneo y la miniatura ya está ahí mientras se
 * escribe el texto.
 *
 * `roomSlug` sólo lo pasa un room abierto: le dice al endpoint DE QUÉ room es el invitado,
 * que es de donde salen su cuota y sus límites de tipo y tamaño.
 */
export function useAdjuntos(opts: { roomSlug?: string; onAdded?: () => void } = {}) {
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const subiendo = pendientes.some((p) => p.uploading);
  const { roomSlug, onAdded } = opts;

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) {
        const localId = `${Date.now()}-${Math.round(Math.random() * 1e6)}-${f.name}`;
        const previewUrl = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
        setPendientes((p) => [
          ...p,
          { localId, name: f.name, mime: f.type || "application/octet-stream", size: f.size, uploading: true, previewUrl },
        ]);
        const fd = new FormData();
        fd.append("file", f);
        const url = roomSlug ? `/api/upload?room=${encodeURIComponent(roomSlug)}` : "/api/upload";
        fetch(url, { method: "POST", body: fd })
          .then(async (r) => {
            if (!r.ok) throw new Error(await r.text());
            return r.json() as Promise<Omit<Pendiente, "localId" | "uploading">>;
          })
          .then((up) =>
            setPendientes((p) =>
              p.map((x) =>
                x.localId === localId
                  ? { ...x, uploading: false, fileId: up.fileId, thumbFileId: up.thumbFileId ?? null, width: up.width ?? null, height: up.height ?? null, pass: up.pass }
                  : x
              )
            )
          )
          .catch(() =>
            setPendientes((p) => p.map((x) => (x.localId === localId ? { ...x, uploading: false, error: true } : x)))
          );
      }
      onAdded?.();
    },
    [roomSlug, onAdded]
  );

  const quitar = useCallback((localId: string) => {
    setPendientes((p) => {
      const fuera = p.find((x) => x.localId === localId);
      if (fuera?.previewUrl) URL.revokeObjectURL(fuera.previewUrl); // sin esto, fuga de memoria
      return p.filter((x) => x.localId !== localId);
    });
  }, []);

  /** Los que ya subieron, en la forma que espera el servidor. Los rotos se descartan. */
  const listos = useCallback(
    () =>
      pendientes
        .filter((p) => p.fileId && !p.error)
        .map((p) => ({
          fileId: p.fileId!,
          mime: p.mime,
          size: p.size,
          name: p.name,
          thumbFileId: p.thumbFileId ?? null,
          width: p.width ?? null,
          height: p.height ?? null,
          pass: p.pass,
        })),
    [pendientes]
  );

  const limpiar = useCallback(() => {
    setPendientes((p) => {
      for (const x of p) if (x.previewUrl) URL.revokeObjectURL(x.previewUrl);
      return [];
    });
  }, []);

  return { pendientes, subiendo, addFiles, quitar, listos, limpiar };
}
