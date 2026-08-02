// ── Leer el documento en voz alta ("como en Word") ───────────────────────────
//
// Lo pidió un cliente durante el demo del 30-jul: no una nota de voz del documento —eso
// sirve para escuchar, no para revisar— sino la lectura DENTRO del documento, resaltando
// el párrafo que suena y con el scroll siguiéndolo. Es lo que se hace antes de firmar.
//
// **La unidad del RESALTADO es el bloque; la de la PETICIÓN es la frase.** Separarlas
// (2026-08-02) es lo único que hace que el play se sienta inmediato: `kokoro-svc`
// sintetiza a ~16 ms por carácter y no hay nada que paralelizar (satura sus 4 vcpus con
// una sola petición; dos a la vez tardan el doble exacto, medido). Pedir un párrafo entero
// son 6.4 s mirando un botón mudo; pedir su primera frase, 1.6. Y como la síntesis va 4×
// más rápida que la reproducción, en cuanto suena algo hay holgura de sobra para tener
// listo lo siguiente. El corte lo define `lib/tts-split`, compartido con el servidor.
//
// ⚠️ **No subas `VENTANA`.** Pedir tres frases a la vez no las trae antes: kokoro las
// atiende en serie, y lo único que se consigue es retrasar la que de verdad urge.
//
// Este módulo no sabe nada de resaltar ni de scrollear: recibe `alBloque(i)` y lo llama
// cuando empieza a sonar el bloque `i`. Quien pinta es el editor, que es el único que
// tiene los nodos.
import { useCallback, useEffect, useRef, useState } from "react";
import { blockText, type DocBlock } from "./doc-blocks";
import { partirEnFrases } from "./tts-split";

export type EstadoLectura = "parado" | "cargando" | "leyendo" | "pausa";

/** Los índices de primer nivel que TIENEN algo que leer. Una imagen o un separador no. */
export function bloquesLegibles(blocks: DocBlock[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blockText(blocks[i]).trim()) out.push(i);
  }
  return out;
}

/** Un trozo que se sintetiza: la frase `s` del bloque `b`. */
type Seg = { b: number; s: number };
const clave = (g: Seg) => `${g.b}:${g.s}`;

/** Lo que devuelve el servidor de un segmento: su audio y cuántos tiene ese bloque. */
type Pieza = { url: string; n: number };

/** Segmentos por delante que se piden. Ver la nota de arriba: no subir. */
const VENTANA = 2;
/** Cuántos segmentos ya oídos conservan su blob antes de que se revoque. */
const COLA_ATRAS = 8;

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
  // El elemento del segmento SIGUIENTE, ya creado y con su blob decodificado. Crear el
  // `Audio` dentro del `onended` ES el hueco entre frases: tiene que existir de antes.
  const siguienteEl = useRef<{ el: HTMLAudioElement; k: string } | null>(null);
  // Todo `Audio` que llegó a existir. `parar()` recorre esto y no sólo `audio.current`:
  // ver la nota de `gen`.
  const vivos = useRef(new Set<HTMLAudioElement>());

  const cola = useRef<Seg[]>([]);
  const pos = useRef(0);
  /** Último bloque de la lectura (inclusive). `null` = hasta el final del documento. */
  const tope = useRef<number | null>(null);
  const ultimoBloque = useRef<number | null>(null);

  // ⚠️ **El token de generación es lo que impide que se encimen varias narraciones.**
  // `sonar()` es async y se detiene en cada `await`. Machacar "siguiente párrafo" lanzaba
  // una cadena por click mientras las anteriores seguían vivas detrás de su await, y cada
  // una acababa creando su propio `Audio` y reproduciéndolo: cuatro voces a la vez y un
  // stop que apagaba una sola.
  //
  // Sólo lo incrementan las acciones del USUARIO (empezar, saltar, parar, desmontar). La
  // recursión de `sonar()` hereda la generación en curso a propósito: si se incrementara
  // en cada paso, cada `onended` invalidaría al siguiente.
  const gen = useRef(0);

  const prefetch = useRef(new Map<string, Promise<Pieza | null>>());
  // Las URLs de blob se revocan al parar y, las ya oídas, sobre la marcha; si no, un
  // documento largo deja decenas de megas colgando en la pestaña.
  const urls = useRef<{ k: string; url: string }[]>([]);
  const vivo = useRef(true);
  const cadena = useRef<Promise<unknown>>(Promise.resolve());

  const url = useCallback(
    (g: Seg) => {
      const q = new URLSearchParams({ i: String(g.b), s: String(g.s) });
      if (version != null && version !== "") q.set("v", String(version));
      return `/api/doc-tts/${documentId}?${q}`;
    },
    [documentId, version],
  );

  /**
   * Ajusta el tramo del bloque `b` para que tenga exactamente `n` segmentos.
   *
   * El cliente corta con su propia copia del documento; con una edición sin guardar sus
   * índices no son los del servidor. `X-Seg-Count` manda, y esto reconcilia sin que el
   * usuario oiga nada raro. Nunca reescribe lo que ya se consumió.
   */
  const reconciliar = useCallback((b: number, n: number) => {
    if (!Number.isFinite(n) || n < 0) return;
    const c = cola.current;
    const desde = c.findIndex((g) => g.b === b);
    if (desde === -1) return;
    let hasta = desde;
    while (hasta + 1 < c.length && c[hasta + 1].b === b) hasta++;
    const actuales = hasta - desde + 1;
    if (actuales === n) return;
    // Si recortar tocaría algo ya reproducido, se deja como está: reordenar el pasado sólo
    // puede desplazar la posición actual a otro párrafo.
    if (n < actuales && pos.current > desde + n - 1) return;
    const nuevos: Seg[] = [];
    for (let s = 0; s < n; s++) nuevos.push({ b, s });
    c.splice(desde, actuales, ...nuevos);
    if (pos.current > desde) pos.current += n - actuales;
  }, []);

  const traer = useCallback(
    (g: Seg): Promise<Pieza | null> => {
      const k = clave(g);
      const ya = prefetch.current.get(k);
      if (ya) return ya;
      const p = fetch(url(g))
        .then(async (r) => {
          const n = Number(r.headers.get("X-Seg-Count"));
          // 204 = el bloque no tenía texto que leer. No es un error: se salta.
          if (r.status === 204) return null;
          // 404 = ese bloque tiene menos frases de las que creíamos. Tampoco es un error:
          // se corrige la cola y se sigue.
          if (r.status === 404) {
            reconciliar(g.b, Number.isFinite(n) ? n : g.s);
            return null;
          }
          if (!r.ok) throw new Error(`tts ${r.status}`);
          const u = URL.createObjectURL(await r.blob());
          urls.current.push({ k, url: u });
          reconciliar(g.b, n);
          return { url: u, n };
        })
        .catch((e) => {
          console.error("[read-aloud]", e);
          throw e;
        });
      prefetch.current.set(k, p);
      return p;
    },
    [url, reconciliar],
  );

  /** Silencia y suelta un elemento. Su blob NO se revoca aquí: puede volver a usarse. */
  const soltar = useCallback((a: HTMLAudioElement | null) => {
    if (!a) return;
    a.onended = null;
    a.onerror = null;
    a.pause();
    vivos.current.delete(a);
  }, []);

  /** Calla TODO lo que esté sonando. Es la red por si algo se escapó del token. */
  const silenciar = useCallback(() => {
    for (const a of Array.from(vivos.current)) soltar(a);
    vivos.current.clear();
    siguienteEl.current = null;
    audio.current = null;
  }, [soltar]);

  const limpiar = useCallback(() => {
    silenciar();
    for (const u of urls.current) URL.revokeObjectURL(u.url);
    urls.current = [];
    prefetch.current.clear();
  }, [silenciar]);

  const parar = useCallback(() => {
    gen.current++;
    limpiar();
    ultimoBloque.current = null;
    tope.current = null;
    setEstado("parado");
    alTerminar();
  }, [limpiar, alTerminar]);

  /** Revoca los blobs de lo que quedó muy atrás. Un documento largo son decenas de MB. */
  const podar = useCallback(() => {
    const vigentes = new Set(cola.current.slice(Math.max(0, pos.current - COLA_ATRAS)).map(clave));
    urls.current = urls.current.filter((u) => {
      if (vigentes.has(u.k)) return true;
      URL.revokeObjectURL(u.url);
      prefetch.current.delete(u.k);
      return false;
    });
  }, []);

  const finDeLectura = useCallback(() => {
    const c = cola.current;
    if (tope.current == null) return c.length - 1;
    const ultimo = c.map((g) => g.b).lastIndexOf(tope.current);
    return ultimo === -1 ? c.length - 1 : ultimo;
  }, []);

  /** Pide, EN SERIE, los siguientes `VENTANA` segmentos que falten. */
  const bombear = useCallback(() => {
    const fin = finDeLectura();
    for (let n = 1; n <= VENTANA; n++) {
      const i = pos.current + n;
      const g = cola.current[i];
      if (!g || i > fin) break;
      if (prefetch.current.has(clave(g))) continue;
      cadena.current = cadena.current.then(() => traer(g).catch(() => null));
    }
  }, [traer, finDeLectura]);

  const construirCola = useCallback((): Seg[] => {
    const docu = bloques();
    const out: Seg[] = [];
    for (const i of bloquesLegibles(docu)) {
      const n = Math.max(1, partirEnFrases(blockText(docu[i]).trim()).length);
      for (let s = 0; s < n; s++) out.push({ b: i, s });
    }
    return out;
  }, [bloques]);

  /**
   * Precrea el elemento del segmento siguiente en cuanto su audio está.
   *
   * `preload="auto"` fuerza la decodificación ahora, para que el `play()` que dispara el
   * `onended` sea instantáneo y no se oiga el corte entre frases.
   */
  const prepararSiguiente = useCallback(
    async (miGen: number) => {
      const sig = cola.current[pos.current + 1];
      if (!sig || pos.current + 1 > finDeLectura()) return;
      const k = clave(sig);
      if (siguienteEl.current?.k === k) return;
      let p: Pieza | null = null;
      try {
        p = await traer(sig);
      } catch {
        return;
      }
      if (!p || gen.current !== miGen || !vivo.current) return;
      const el = new Audio(p.url);
      el.preload = "auto";
      el.playbackRate = velocidad;
      siguienteEl.current = { el, k };
    },
    [traer, velocidad, finDeLectura],
  );

  // Reproduce el segmento que toca y encadena. Es recursivo por `onended` y no por un
  // bucle con `await`: así pausar es `audio.pause()` y no hay que cancelar nada en vuelo.
  const sonar = useCallback(
    async function sonar(): Promise<void> {
      const mi = gen.current;
      const sigo = () => vivo.current && gen.current === mi;

      const g = cola.current[pos.current];
      if (!g || pos.current > finDeLectura()) {
        parar();
        return;
      }

      // Si ya está precargado no se pinta "cargando": un spinner de 40 ms sólo parpadea.
      const k = clave(g);
      if (!prefetch.current.has(k)) setEstado("cargando");

      let pieza: Pieza | null;
      try {
        pieza = await traer(g);
      } catch {
        setError("No se pudo generar la voz");
        parar();
        return;
      }
      if (!sigo()) return;

      // Sin audio (bloque vacío, o frase que el servidor no tiene): al siguiente.
      if (!pieza) {
        pos.current++;
        return sonar();
      }

      if (g.b !== ultimoBloque.current) {
        ultimoBloque.current = g.b;
        alBloque(g.b);
      }

      const pre = siguienteEl.current;
      const a = pre?.k === k ? pre.el : new Audio(pieza.url);
      if (pre?.k === k) siguienteEl.current = null;
      a.playbackRate = velocidad;
      vivos.current.add(a);
      audio.current = a;

      const seguir = () => {
        if (gen.current !== mi) return; // una cadena vieja no mueve nada
        soltar(a);
        pos.current++;
        podar();
        void sonar();
      };
      a.onended = seguir;
      // Un segmento que no se puede reproducir no tumba la lectura entera.
      a.onerror = seguir;

      bombear();
      try {
        await a.play();
        if (sigo()) setEstado("leyendo");
      } catch {
        // Autoplay bloqueado, o el usuario pausó entre medias.
        if (sigo()) setEstado("pausa");
      }
      void prepararSiguiente(mi);
    },
    [traer, alBloque, parar, velocidad, bombear, podar, soltar, prepararSiguiente, finDeLectura],
  );

  /**
   * Arranca en un bloque concreto, opcionalmente acotando dónde termina.
   *
   * `hasta` (índice de bloque, inclusive) es lo que distingue "leer la selección" de "leer
   * desde aquí": la primera se detiene sola al acabar el último bloque marcado.
   */
  const empezarEn = useCallback(
    (bloque?: number, hasta?: number) => {
      if (!documentId) return;
      gen.current++;
      setError(null);
      // Se silencia, pero NO se tiran los blobs: el cebo del hover vive en `prefetch` y
      // tirarlo aquí devolvería justo la espera que ese cebo quita.
      silenciar();
      cola.current = construirCola();
      if (!cola.current.length) return;
      const desde = bloque == null ? 0 : cola.current.findIndex((g) => g.b >= bloque);
      pos.current = desde === -1 ? 0 : desde;
      tope.current = hasta == null ? null : hasta;
      ultimoBloque.current = null;
      podar();
      void sonar();
    },
    [documentId, silenciar, construirCola, sonar, podar],
  );

  const empezar = useCallback(() => empezarEn(), [empezarEn]);

  /** Trae la primera frase sin reproducir nada: el play posterior arranca en seco. */
  const cebar = useCallback(() => {
    if (!documentId || estado !== "parado") return;
    const docu = bloques();
    const primero = bloquesLegibles(docu)[0];
    if (primero === undefined) return;
    traer({ b: primero, s: 0 }).catch(() => {});
  }, [documentId, estado, bloques, traer]);

  const pausar = useCallback(() => {
    audio.current?.pause();
    setEstado("pausa");
  }, []);

  const reanudar = useCallback(() => {
    const a = audio.current;
    // Sin elemento vivo se retoma DONDE SE QUEDÓ, no desde el principio: reiniciar un
    // documento largo por darle a play es la peor forma de perder el sitio.
    if (!a) {
      if (!cola.current.length) return empezarEn();
      void sonar();
      return;
    }
    void a.play().then(() => setEstado("leyendo"));
  }, [empezarEn, sonar]);

  /** Salta de PÁRRAFO (no de frase): es lo que dicen los botones ‹ ›. */
  const saltar = useCallback(
    (delta: number) => {
      const c = cola.current;
      if (!c.length) return;
      const actual = c[pos.current]?.b ?? c[0].b;
      const orden = Array.from(new Set(c.map((g) => g.b)));
      const donde = orden.indexOf(actual);
      const destino = Math.min(Math.max(donde + delta, 0), orden.length - 1);
      gen.current++;
      silenciar();
      pos.current = c.findIndex((g) => g.b === orden[destino]);
      ultimoBloque.current = null;
      podar();
      void sonar();
    },
    [silenciar, sonar, podar],
  );

  // Cambiar la velocidad aplica AL VUELO al párrafo que ya está sonando: esperar al
  // siguiente se siente como que el control no responde. Y al precargado también, o la
  // frase siguiente arrancaría a 1× y el salto se oye.
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = velocidad;
    if (siguienteEl.current) siguienteEl.current.el.playbackRate = velocidad;
  }, [velocidad]);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
      gen.current++;
      limpiar();
    };
  }, [limpiar]);

  return {
    estado,
    error,
    velocidad,
    setVelocidad,
    empezar,
    empezarEn,
    cebar,
    pausar,
    reanudar,
    parar,
    saltar,
    leyendo: estado === "leyendo" || estado === "cargando",
  };
}
