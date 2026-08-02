// ── Leer el documento en voz alta ("como en Word") ───────────────────────────
//
// Lo pidió un cliente durante el demo del 30-jul: no una nota de voz del documento —eso
// sirve para escuchar, no para revisar— sino la lectura DENTRO del documento, resaltando
// el párrafo que suena y con el scroll siguiéndolo. Es lo que se hace antes de firmar.
//
// La unidad es el BLOQUE, y no por comodidad: `kokoro-svc` devuelve la duración total del
// audio y ningún timestamp, así que no hay forma de partir un audio largo en párrafos.
// Sintetizando uno por bloque, la unidad del audio ya ES la unidad del resaltado. (El
// escalón por PALABRA vendría después, alineando con `whisper-svc`; encima de esto, no en
// lugar de esto.)
//
// Este módulo no sabe nada de resaltar ni de scrollear: recibe `alBloque(i)` y lo llama
// cuando empieza a sonar el bloque `i`. Quien pinta es el editor, que es el único que
// tiene los nodos.
import { useCallback, useEffect, useRef, useState } from "react";
import { blockText, type DocBlock } from "./doc-blocks";

export type EstadoLectura = "parado" | "cargando" | "leyendo" | "pausa";

/** Los índices de primer nivel que TIENEN algo que leer. Una imagen o un separador no. */
export function bloquesLegibles(blocks: DocBlock[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blockText(blocks[i]).trim()) out.push(i);
  }
  return out;
}

type Opts = {
  documentId?: string;
  /** La versión que se está MIRANDO (`?v`), para leer lo mismo que se ve. */
  version?: string | number | null;
  /** Los bloques del editor, en el mismo orden que indexa el servidor. */
  bloques: () => DocBlock[];
  /** Empieza a sonar el bloque `i`: resáltalo y llévame ahí. */
  alBloque: (i: number) => void;
  /** Se acabó (o se detuvo): quita la marca. */
  alTerminar: () => void;
};

export function useReadAloud({ documentId, version, bloques, alBloque, alTerminar }: Opts) {
  const [estado, setEstado] = useState<EstadoLectura>("parado");
  const [velocidad, setVelocidad] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const audio = useRef<HTMLAudioElement | null>(null);
  const lista = useRef<number[]>([]);
  const pos = useRef(0);
  // Precargados por índice de bloque. El siguiente se pide MIENTRAS suena el actual: sin
  // esto hay un silencio de segundos entre párrafos, que es justo lo que rompe la
  // sensación de que te están leyendo.
  const prefetch = useRef(new Map<number, Promise<string | null>>());
  // Las URLs de blob se revocan al parar; si no, cada lectura de un documento largo deja
  // decenas de megas colgando en la pestaña.
  const urls = useRef<string[]>([]);
  const vivo = useRef(true);

  const url = useCallback(
    (i: number) => {
      const q = new URLSearchParams({ i: String(i) });
      if (version != null && version !== "") q.set("v", String(version));
      return `/api/doc-tts/${documentId}?${q}`;
    },
    [documentId, version],
  );

  const traer = useCallback(
    (i: number): Promise<string | null> => {
      const ya = prefetch.current.get(i);
      if (ya) return ya;
      const p = fetch(url(i))
        .then(async (r) => {
          // 204 = el bloque no tenía texto que leer. No es un error: se salta.
          if (r.status === 204) return null;
          if (!r.ok) throw new Error(`tts ${r.status}`);
          const u = URL.createObjectURL(await r.blob());
          urls.current.push(u);
          return u;
        })
        .catch((e) => {
          console.error("[read-aloud]", e);
          throw e;
        });
      prefetch.current.set(i, p);
      return p;
    },
    [url],
  );

  const limpiar = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    prefetch.current.clear();
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
  }, []);

  const parar = useCallback(() => {
    limpiar();
    setEstado("parado");
    alTerminar();
  }, [limpiar, alTerminar]);

  // Reproduce el bloque que toca y encadena. Es recursivo por `onended` y no por un bucle
  // con `await`: así pausar es `audio.pause()` y no hay que cancelar nada en vuelo.
  const sonar = useCallback(
    async function sonar(): Promise<void> {
      if (!vivo.current) return;
      const i = lista.current[pos.current];
      if (i === undefined) {
        parar();
        return;
      }
      setEstado("cargando");
      let src: string | null;
      try {
        src = await traer(i);
      } catch {
        setError("No se pudo generar la voz");
        parar();
        return;
      }
      if (!vivo.current) return;
      // Sin audio (bloque vacío): al siguiente, sin ruido ni pausa.
      if (!src) {
        pos.current++;
        return sonar();
      }

      alBloque(i);
      // El siguiente se va pidiendo ya, mientras éste suena.
      const sig = lista.current[pos.current + 1];
      if (sig !== undefined) traer(sig).catch(() => {});

      const a = new Audio(src);
      a.playbackRate = velocidad;
      audio.current = a;
      a.onended = () => {
        pos.current++;
        void sonar();
      };
      a.onerror = () => {
        // Un bloque que no se puede reproducir no tumba la lectura entera.
        pos.current++;
        void sonar();
      };
      try {
        await a.play();
        setEstado("leyendo");
      } catch {
        // Autoplay bloqueado, o el usuario pausó entre medias.
        setEstado("pausa");
      }
    },
    [traer, alBloque, parar, velocidad],
  );

  const empezar = useCallback(() => {
    if (!documentId) return;
    setError(null);
    limpiar();
    lista.current = bloquesLegibles(bloques());
    pos.current = 0;
    if (!lista.current.length) return;
    void sonar();
  }, [documentId, bloques, limpiar, sonar]);

  const pausar = useCallback(() => {
    audio.current?.pause();
    setEstado("pausa");
  }, []);

  const reanudar = useCallback(() => {
    const a = audio.current;
    if (!a) return empezar();
    void a.play().then(() => setEstado("leyendo"));
  }, [empezar]);

  const saltar = useCallback(
    (delta: number) => {
      if (!lista.current.length) return;
      const destino = Math.min(Math.max(pos.current + delta, 0), lista.current.length - 1);
      pos.current = destino;
      audio.current?.pause();
      audio.current = null;
      void sonar();
    },
    [sonar],
  );

  // Cambiar la velocidad aplica AL VUELO al párrafo que ya está sonando: esperar al
  // siguiente se siente como que el control no responde.
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = velocidad;
  }, [velocidad]);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
      limpiar();
    };
  }, [limpiar]);

  return {
    estado,
    error,
    velocidad,
    setVelocidad,
    empezar,
    pausar,
    reanudar,
    parar,
    saltar,
    leyendo: estado === "leyendo" || estado === "cargando",
  };
}
