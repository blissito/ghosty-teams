import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Pencil,
  Play,
  SpellCheck,
  Square,
  TriangleAlert,
  Volume2,
  X,
} from "lucide-react";
import { BlockNoteView } from "@blocknote/mantine";
import { useT } from "../i18n";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteSchema } from "@blocknote/core";
import { en as blockNoteEn } from "@blocknote/core/locales";
import {
  withMultiColumn,
  multiColumnDropCursor,
  locales as multiColumnLocales,
} from "@blocknote/xl-multi-column";
import {
  aliasTable,
  blockSignature,
  blockTextMapped,
  rangoCrudo,
  reemplazarEnBloque,
  type DocBlock,
} from "../lib/doc-blocks";
import { reconcile } from "../lib/doc-reconcile";
import { useReadAloud } from "../lib/read-aloud";
import { useDocReview, type Hallazgo } from "../lib/doc-review";
import { rangoEnBloque } from "../lib/doc-dom-range";

// ── El editor de documentos de texto ──────────────────────────────────────────
//
// BlockNote (bloques estilo Notion sobre ProseMirror). Antes un `eb-doc` se pintaba
// como markdown renderizado en una hoja blanca: bonito, pero muerto — no se podía
// tocar. Ahora el documento se REDACTA dentro del editor real y queda editable en
// cuanto el agente suelta el turno.
//
// Este archivo es `CollabEditor.tsx` nativizado: se le quitaron HocuspocusProvider,
// el `collaboration:{}`, la siembra por HTML y la persistencia a Landing.sections de
// EasyBits. La co-edición vuelve como un prop `collab?` opcional cuando exista el
// sync server; el modelo de datos (bloques con uuid) ya está listo para eso.
//
// Se carga LAZY desde DocSurface: BlockNote + Mantine son pesados y no deben entrar
// al bundle inicial del chat.

/**
 * Versiones cuyo cambio YA se señaló en esta pestaña.
 *
 * `changedIds` viaja persistido en el sobre, así que sin esto el documento se resaltaría
 * cada vez que lo abres, incluso una semana después. La marca dice "esto acaba de
 * cambiar", no se queda puesta.
 *
 * Vive en el módulo y se consulta DENTRO del efecto, nunca en el render: un render se
 * puede descartar (Suspense) y repetir, y marcar ahí se come el resaltado.
 */
const yaSenalado = new Set<string>();

/**
 * El elemento que DE VERDAD scrollea, buscándolo desde el nodo hacia arriba.
 *
 * No se puede asumir cuál es. El panel de artefactos monta el contenido dentro de un
 * bloque con `overflow-auto` que NO es flex container, así que un `h-full`/`flex-1` en
 * el hijo no lo acota: el div del editor crece hasta el alto de todo el documento
 * (~14.800px en uno de 102 bloques) y su propio `overflow-auto` nunca entra en juego.
 * Calcular el scroll contra él daba destinos absurdos —`destino: -7381` con
 * `scrollTop: 0`— y el `Math.max(0, …)` lo dejaba clavado arriba.
 *
 * El mismo comentario ya está en ArtifactPanel para la rama del artefacto HTML. Es una
 * trampa que muerde dos veces, así que aquí se resuelve mirando el DOM en vez de creer
 * en las clases.
 */
function contenedorQueScrollea(desde: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = desde;
  while (el && el !== document.body) {
    const ov = getComputedStyle(el).overflowY;
    if ((ov === "auto" || ov === "scroll") && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Ejecuta `fn` cuando la persona esté MIRANDO: pestaña visible y ventana enfocada.
 *
 * Sin esto la animación se gasta en el vacío. El turno del agente tarda, y lo normal es
 * irse a otra cosa mientras trabaja: al volver, el marcatextos ya se desvaneció y el
 * cambio quedó igual de invisible que si no lo hubiéramos señalado. Y es justo cuando más
 * falta hace, porque vuelves sin saber qué tocó.
 *
 * `hasFocus()` además de `visibilityState`: una ventana puede estar visible en un segundo
 * monitor con el foco en otra app. Devuelve una función para dejar de esperar (el editor
 * puede desmontarse antes de que vuelvas).
 */
function cuandoMire(fn: () => void): () => void {
  const mirando = () => document.visibilityState === "visible" && document.hasFocus();
  if (mirando()) {
    fn();
    return () => {};
  }
  const quitar = () => {
    document.removeEventListener("visibilitychange", alVolver);
    window.removeEventListener("focus", alVolver);
  };
  function alVolver() {
    if (!mirando()) return;
    quitar();
    // Un frame de gracia: al volver de otra app el compositor todavía está pintando, y una
    // animación que arranca en ese momento se ve a tirones.
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }
  document.addEventListener("visibilitychange", alVolver);
  window.addEventListener("focus", alVolver);
  return quitar;
}

const schema = withMultiColumn(BlockNoteSchema.create());
const dictionary = { ...blockNoteEn, multi_column: multiColumnLocales.en };

export default function DocEditor({
  blocks,
  markdown,
  editable,
  streaming,
  onChange,
  highlightIds,
  patchRefs,
  guardado,
  guardarYa,
  documentId,
  version,
}: {
  /** La verdad, ya en bloques (documento publicado con sobre `v:1`). */
  blocks?: DocBlock[];
  /**
   * Markdown a convertir aquí dentro: es el caso del STREAMING (el agente escribe
   * markdown en el fence) y de las filas legacy anteriores al sobre. La conversión
   * vive en este componente porque `tryParseMarkdownToBlocks` es un método del
   * editor — hacerla fuera exigiría un segundo editor headless sólo para parsear.
   */
  markdown?: string;
  editable: boolean;
  /** El agente está escribiendo: mostramos el pulso y no dejamos editar. */
  streaming: boolean;
  /** Cambios hechos por una PERSONA (no los del reconciliador). */
  onChange?: (blocks: DocBlock[]) => void;
  /**
   * uuid de los bloques que cambiaron en esta versión (vienen del sobre). Se señalan al
   * montar: es el caso NORMAL, porque el panel se abre DESPUÉS de que el agente contestó.
   * La detección por diff de abajo sólo cubre el caso raro de tenerlo ya abierto.
   */
  highlightIds?: string[];
  /**
   * Alias (`n3`) de los bloques que el agente está tocando EN ESTE TURNO. Llegan del
   * stream, antes de que el server publique nada: es lo que permite marcar en el momento
   * de la edición en vez de reconstruirlo después.
   */
  patchRefs?: string[];
  /** Estado del autoguardado, para mostrarlo. */
  guardado?: "pendiente" | "guardando" | "ok" | "error" | null;
  /**
   * Fuerza el guardado y resuelve cuando terminó.
   *
   * La voz la sintetiza el SERVIDOR desde el documento guardado. Sin esperar aquí, editar
   * un párrafo y darle a la bocina reproduce el texto ANTERIOR —el que todavía está en la
   * base— y desde fuera parece un caché que no se invalida.
   */
  guardarYa?: () => Promise<void>;
  /**
   * El documento, para pedirle su voz al servidor. Sin él no hay "leer en voz alta": un
   * borrador en vivo todavía no es una fila, así que no hay de dónde sacar el audio.
   */
  documentId?: string;
  /** La versión que se está MIRANDO (`?v`): se lee lo mismo que se ve. */
  version?: string | number | null;
}) {
  const t = useT();
  const editor = useCreateBlockNote({
    schema,
    dropCursor: multiColumnDropCursor,
    dictionary,
    // Sólo se lee en el primer render; de ahí en adelante manda `reconcile`.
    initialContent: blocks?.length ? (blocks as never) : undefined,
  });

  // El reconciliador escribe en el editor y eso dispara onChange. Sin esta bandera
  // cada tick del agente se reportaría como edición humana: autosave en bucle y
  // `humanEdited` en true sin que nadie haya tocado nada.
  const applying = useRef(false);
  const seen = useRef<string>("");

  // ── Autoscroll mientras el agente escribe ───────────────────────────────────
  // Sigue al texto conforme aparece, pero SÓLO si estás abajo. Si subiste a leer una
  // cláusula anterior, arrastrarte al final en cada tick haría el documento
  // ilegible justo mientras se escribe — que es cuando más se quiere leer.
  const scroller = useRef<HTMLDivElement>(null);
  // El ref lo lee el efecto (sin re-render por tick); el state pinta el botón. Los dos,
  // porque leer el state dentro del efecto lo ataría a su closure.
  const pegado = useRef(true);
  const [alFondo, setAlFondo] = useState(true);
  const [alTope, setAlTope] = useState(true);
  /**
   * Posición del botón "ir al final", en coordenadas de pantalla.
   *
   * No puede ser `absolute` respecto al div del editor: ese div NO está acotado (el
   * contenedor del panel tiene overflow-auto pero no es flex container, así que `flex-1`
   * y `h-full` no lo limitan), así que mide el alto de TODO el documento —unos 14.800px
   * con 100 bloques— y un `bottom-5` cae 14.800px hacia abajo, fuera de la pantalla. El
   * botón existía y no se veía. Es la tercera vez que esta trampa muerde en este archivo.
   */
  const [posBoton, setPosBoton] = useState<{
    left: number;
    right: number;
    top: number;
    /** Esquina superior del contenedor VISIBLE: ahí vive la barra de lectura. */
    arriba: number;
    /** Su separación del borde derecho, ya en unidades de `right` de CSS. */
    derecha: number;
    /** Ancho VISIBLE del contenedor: los flotantes no pueden pasarse de ahí. */
    ancho: number;
  } | null>(null);

  const alFinal = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const alPrincipio = (el: HTMLElement) => el.scrollTop < 120;

  /** El contenedor real. Se resuelve cada vez: el panel puede remontarse. */
  const caja = useCallback(
    () => contenedorQueScrollea(scroller.current) ?? scroller.current,
    [],
  );

  // El listener va en el contenedor REAL, no en nuestro div: como nuestro div no
  // scrollea (no está acotado), su evento `scroll` no se disparaba nunca y `alFondo`
  // se quedaba en true para siempre — de ahí que el botón de "ir al final" tampoco
  // apareciera jamás.
  useEffect(() => {
    let el: HTMLElement | null = null;
    let on: (() => void) | null = null;
    let ro: ResizeObserver | null = null;
    let t: ReturnType<typeof setTimeout>;
    let intentos = 0;

    // Se REINTENTA porque al montar el documento todavía no está pintado: sin contenido no
    // hay desbordamiento, `contenedorQueScrollea` devuelve null y el listener acababa en
    // nuestro div — que nunca scrollea, así que `alFondo` se quedaba en true para siempre y
    // el botón de "ir al final" no aparecía nunca. Con 100 bloques eso tarda.
    const enganchar = () => {
      const box = contenedorQueScrollea(scroller.current);
      if (!box) {
        if (++intentos < 60) t = setTimeout(enganchar, 100); // ~6s
        return;
      }
      el = box;
      on = () => {
        const v = alFinal(box);
        pegado.current = v;
        setAlFondo((prev) => (prev === v ? prev : v));
        const arriba = alPrincipio(box);
        setAlTope((prev) => (prev === arriba ? prev : arriba));
        // El botón se ancla a la esquina del contenedor VISIBLE, no del documento.
        const r = box.getBoundingClientRect();
        const p = {
          left: Math.round(r.left + 16),
          right: Math.round(r.right - 150),
          top: Math.round(r.bottom - 52),
          arriba: Math.round(r.top + 12),
          // Nunca menos de 12px del borde de la VENTANA: con el panel pegado a la derecha
          // (o con la barra de scroll de por medio) el cálculo salía negativo y los
          // controles se cortaban por fuera de la pantalla.
          derecha: Math.max(12, Math.round(window.innerWidth - r.right + 12)),
          ancho: Math.round(r.width),
        };
        setPosBoton((prev) =>
          prev &&
          prev.left === p.left &&
          prev.right === p.right &&
          prev.top === p.top &&
          prev.arriba === p.arriba &&
          prev.derecha === p.derecha &&
          prev.ancho === p.ancho
            ? prev
            : p,
        );
      };
      box.addEventListener("scroll", on, { passive: true });
      window.addEventListener("resize", on);
      // ⚠️ Y al TAMAÑO del contenedor, no sólo a `resize` de la ventana. El panel se
      // cierra animando su ancho, y durante esa animación no hay scroll ni resize: los
      // controles flotantes —que van `fixed` sobre el rect del panel— se quedaban clavados
      // en su sitio mientras el documento se iba por debajo. Un desfase de medio segundo
      // que se ve fatal justo en el gesto de cerrar.
      ro = new ResizeObserver(on);
      ro.observe(box);
      on();
    };
    enganchar();

    return () => {
      clearTimeout(t);
      ro?.disconnect();
      if (el && on) {
        el.removeEventListener("scroll", on);
        window.removeEventListener("resize", on);
      }
    };
  }, [caja, editor, blocks, markdown]);

  /**
   * Marca bloques por POSICIÓN, dibujando la señal ENCIMA con elementos propios.
   *
   * No se le pone una clase al bloque, y esto costó descubrirlo: BlockNote pinta el
   * contenido con node views de REACT, así que React es dueño del `className` de
   * `.bn-block-content` y en su siguiente render lo reescribe — borrando la clase. El
   * observador de mutaciones veía el `add` y `querySelectorAll(".gt-cambio")` devolvía
   * cero un instante después, sin una sola mutación de borrado: React no la quitaba, la
   * sobrescribía.
   *
   * Así que la marca es un overlay `position:fixed` sobre el rect del bloque, en un
   * contenedor que React no gestiona. Nadie más lo toca. Sigue al bloque con rAF mientras
   * dura (el documento puede scrollear debajo) y se borra solo.
   *
   * Por POSICIÓN y no por id porque el reconciliador reemplaza el bloque y le cambia el
   * uuid; el índice sobrevive a un `replace`.
   */
  const capa = useRef<HTMLDivElement | null>(null);
  const raf = useRef<number>(0);

  const limpiarMarca = useCallback(() => {
    cancelAnimationFrame(raf.current);
    capa.current?.remove();
    capa.current = null;
  }, []);

  const marcarIndices = useCallback(
    (indices: number[], irAhi: boolean): boolean => {
      if (!editor || !indices.length) return false;
      const docu = (editor.document ?? []) as DocBlock[];
      const nodos = indices
        .map((i) => docu[i]?.id)
        .filter((id): id is string => !!id)
        .map((id) => document.querySelector<HTMLElement>(`.gt-doc [data-id="${CSS.escape(id)}"]`))
        .filter((n): n is HTMLElement => !!n && document.contains(n) && n.offsetParent !== null);
      if (!nodos.length) return false;

      limpiarMarca();
      const capaEl = document.createElement("div");
      capaEl.dataset.gtMarca = "1";
      // ⚠️ Por ENCIMA del panel expandido, que es `z-[100]` (ArtifactPanel). La capa vive en
      // `document.body`, o sea que compite con él: con z-index 60 el resaltado quedaba
      // literalmente debajo y desaparecía al ampliar — que es cuando más se quiere ver.
      capaEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:120";
      const cajas = nodos.map(() => {
        const d = document.createElement("div");
        d.className = "gt-cambio";
        d.style.position = "fixed";
        capaEl.appendChild(d);
        return d;
      });
      document.body.appendChild(capaEl);
      capa.current = capaEl;

      // Sigue al bloque: el documento puede scrollear (nuestro propio scroll, el del
      // usuario, o un reflow de BlockNote) y una caja quieta se despegaría del texto.
      //
      // ⚠️ Y si el NODO se fue, la marca se vuelve a resolver por id. Expandir el panel
      // remonta el editor entero: los nodos que teníamos quedan huérfanos, sus rects se
      // congelan en 0 y el resaltado desaparecía justo al ampliar — que es cuando más se
      // quiere ver. Lo mismo vale para cualquier reemplazo de nodos que no venga del
      // reconciliador (ése ya reaplica por su cuenta).
      const seguir = () => {
        if (nodos.some((n) => !document.contains(n))) {
          const m = marca.current;
          raf.current = 0;
          if (m) requestAnimationFrame(() => marcarIndicesRef.current?.(m.indices, false));
          return;
        }
        for (let i = 0; i < nodos.length; i++) {
          const r = nodos[i].getBoundingClientRect();
          const d = cajas[i];
          d.style.top = `${r.top - 3}px`;
          d.style.left = `${r.left - 4}px`;
          d.style.width = `${r.width + 8}px`;
          d.style.height = `${r.height + 6}px`;
        }
        raf.current = requestAnimationFrame(seguir);
      };
      seguir();

      if (irAhi) {
        const box = contenedorQueScrollea(nodos[0]);
        if (box) {
          const r = nodos[0].getBoundingClientRect();
          const base = box.getBoundingClientRect();
          const destino = box.scrollTop + (r.top - base.top) - box.clientHeight / 2 + r.height / 2;
          box.scrollTo({ top: Math.max(0, destino), behavior: "smooth" });
          pegado.current = false;
          setAlFondo(false);
        }
      }
      return true;
    },
    [editor, limpiarMarca],
  );

  // La marca se re-resuelve a sí misma desde su propio rAF; el ref rompe el ciclo.
  const marcarIndicesRef = useRef<typeof marcarIndices | null>(null);
  marcarIndicesRef.current = marcarIndices;

  useEffect(() => () => { esperando.current?.(); limpiarMarca(); }, [limpiarMarca]);

  const irAlPrincipio = useCallback(() => {
    const el = caja();
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
    // Ir arriba es soltarse del final: si no, el siguiente tick del autoscroll te devuelve.
    pegado.current = false;
    setAlFondo(false);
  }, [caja]);

  const irAlFondo = useCallback(() => {
    const el = caja();
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // Se vuelve a "pegar" ya: si no, un tick que llegue durante el scroll suave lo
    // cancelaría y el botón se quedaría puesto.
    pegado.current = true;
    setAlFondo(true);
  }, [caja]);

  useEffect(() => {
    if (!editor) return;

    // Ojo: en el editor del CLIENTE `tryParseMarkdownToBlocks` es SINCRÓNICO (el
    // headless del server, `ServerBlockNoteEditor`, sí devuelve promesa). Al ser
    // sincrónico no hay parseos que resuelvan fuera de orden, así que no hace falta
    // guardar generaciones.
    let next: DocBlock[];
    if (blocks?.length) {
      next = blocks;
    } else if (markdown?.trim()) {
      try {
        next = editor.tryParseMarkdownToBlocks(markdown) as DocBlock[];
      } catch {
        return; // markdown a medias en pleno stream: el próximo tick lo arregla
      }
    } else {
      return;
    }
    if (!next.length) return;

    // Firma del documento entrante: si no cambió, no hay nada que hacer. El body del
    // turno se re-emite COMPLETO por tick, no sólo cuando el documento cambia.
    const sig = next.map(blockSignature).join(" ");
    if (sig === seen.current) return;
    seen.current = sig;
    applying.current = true;
    try {
      reconcile(editor as never, next);
    } finally {
      // Se libera en microtask: las transacciones de ProseMirror notifican onChange
      // sincrónicamente, pero el editor puede encolar pasos derivados.
      queueMicrotask(() => {
        applying.current = false;
        // Tras el repintado del bloque nuevo, seguir al texto. Va DENTRO del microtask
        // porque antes de que ProseMirror aplique la transacción el `scrollHeight`
        // todavía es el de antes y el salto se quedaría corto.
        const el = caja();
        if (streaming && pegado.current && el) el.scrollTop = el.scrollHeight;
        // El reconciliador acaba de reemplazar nodos: si hay una marca viva, se vuelve a
        // poner sobre los nuevos. Sin esto, la primera republicación del server la borraba
        // y parecía que nunca se había pintado.
        const m = marca.current;
        if (m && Date.now() < m.hasta) marcarIndices(m.indices, false);

      });
    }
  }, [editor, blocks, markdown, streaming, caja, marcarIndices]);

  /**
   * Marca VIVA: qué posiciones están señaladas y hasta cuándo.
   *
   * Vive en un ref porque el reconciliador la vuelve a aplicar en cada actualización del
   * documento: sin eso, la primera republicación del server borraba la marca (el bloque se
   * reemplaza y la clase se va con el nodo viejo) y desde fuera parecía que nunca se
   * había pintado.
   */
  const marca = useRef<{ indices: number[]; hasta: number } | null>(null);

  /** Cancela una espera de visibilidad pendiente (si el editor se desmonta antes). */
  const esperando = useRef<(() => void) | null>(null);

  const señalar = useCallback(
    (indices: number[], ms = 9000) => {
      if (!indices.length) return;
      marca.current = { indices, hasta: Number.POSITIVE_INFINITY };
      esperando.current?.();

      // La marca se pinta y el reloj del desvanecido arranca cuando la persona MIRA, no
      // cuando el patch llega. Si está en otra app, esto queda esperando su vuelta.
      esperando.current = cuandoMire(() => {
        esperando.current = null;
        marca.current = { indices, hasta: Date.now() + ms };
        // Reintenta hasta que los nodos estén pintados: BlockNote tarda lo que tarda con
        // 100 bloques, y un plazo fijo es una apuesta.
        let n = 0;
        const probar = () => {
          if (marcarIndices(indices, n === 0) || ++n > 40) return;
          setTimeout(probar, 60);
        };
        probar();
        setTimeout(() => {
          if (!marca.current || marca.current.indices !== indices) return;
          marca.current = null;
          // Desvanecido y fuera. La capa es nuestra, así que basta con marcarla.
          capa.current?.querySelectorAll(".gt-cambio").forEach((d) => d.classList.add("gt-cambio-fin"));
          setTimeout(limpiarMarca, 700);
        }, ms);
      });
    },
    [marcarIndices, limpiarMarca],
  );

  // ── Leer en voz alta ────────────────────────────────────────────────────────
  //
  // Reusa la MISMA capa de resaltado que el cambio quirúrgico, con una diferencia que
  // importa: aquí la marca NO se desvanece sola ni espera a que la persona mire. Lo que
  // manda es el audio — mientras suena el párrafo, el párrafo está marcado.
  /** El párrafo que suena ahora mismo, para que su bocina sea un stop y no un play. */
  const [leyendoI, setLeyendoI] = useState<number | null>(null);
  // El párrafo que se acaba de PEDIR. Entre el clic y el primer sonido puede haber un par
  // de segundos de síntesis, y sin esto la bocina se queda igual: parece que no registró
  // el clic y la gente vuelve a pulsar. `leyendoI` no sirve aquí — se fija cuando el audio
  // YA empezó, o sea justo cuando el spinner deja de hacer falta.
  const [pedidoI, setPedidoI] = useState<number | null>(null);

  const marcarLectura = useCallback(
    (i: number) => {
      setLeyendoI(i);
      // `hasta: Infinity` para que el reconciliador la vuelva a poner si el documento se
      // repinta a media lectura (un autoguardado, una republicación del agente).
      marca.current = { indices: [i], hasta: Number.POSITIVE_INFINITY };
      // Reintenta: con 100 bloques, BlockNote puede no tener pintado todavía el nodo al
      // que acabamos de saltar.
      let n = 0;
      const probar = () => {
        if (marcarIndices([i], n === 0) || ++n > 20) return;
        setTimeout(probar, 60);
      };
      probar();
    },
    [marcarIndices],
  );

  const finLectura = useCallback(() => {
    setLeyendoI(null);
    setPedidoI(null);
    marca.current = null;
    limpiarMarca();
  }, [limpiarMarca]);

  const bloquesActuales = useCallback(
    () => ((editor?.document ?? []) as DocBlock[]),
    [editor],
  );

  /**
   * ⚠️ La versión que se revisa (y que se lee en voz alta) NO puede ser la del mensaje
   * cuando el documento es editable.
   *
   * `version` es la fila que abriste; en cuanto guardas una edición, el documento vivo es
   * OTRA fila — y sus bloques llevan uuid distintos. Pidiendo la vieja, el servidor
   * devolvía hallazgos con `blockId` que en el editor no existen: no se encontraba el
   * nodo, así que ni se subrayaba ni se saltaba al párrafo. Se veía como "no destaca",
   * que es justo lo que no deja adivinar la causa.
   *
   * Editando se mira SIEMPRE la viva (que es lo que el editor tiene, y lo que
   * `guardarYa` acaba de dejar escrito). La versión fijada sólo manda en sólo-lectura,
   * que es cuando de verdad estás viendo una versión antigua.
   */
  const versionVigente = editable ? null : version;

  const voz = useReadAloud({
    documentId,
    version: versionVigente,
    bloques: bloquesActuales,
    alBloque: marcarLectura,
    alTerminar: finLectura,
  });

  /**
   * Único punto de arranque de la lectura: guarda primero, lee después.
   *
   * El audio no sale del texto que tiene el editor sino del documento GUARDADO, que es lo
   * que hace que el permiso y la versión sean los del documento y no los que diga el
   * cliente. La contrapartida es ésta: si hay una edición esperando el debounce, hay que
   * vaciarla antes o se escucha la versión anterior de la frase.
   */
  const leerDesde = useCallback(
    async (bloque?: number, hasta?: number) => {
      if (bloque != null) setPedidoI(bloque);
      try {
        await guardarYa?.();
      } catch {
        // Si el guardado falla ya se ve en su propio indicador; leer el texto de la base
        // es lo mejor que se puede hacer con lo que hay.
      }
      voz.empezarEn(bloque, hasta);
    },
    [guardarYa, voz],
  );

  // ── Revisión ortográfica ────────────────────────────────────────────────────
  //
  // Capa PROPIA, separada de la del cambio quirúrgico y la lectura: pinta muchas marcas a
  // la vez (un documento largo trae decenas), son de PALABRA y no de bloque, y viven
  // mientras dure la revisión en vez de desvanecerse. Mezclarlas en `marcarIndices` habría
  // significado tocar dos cosas que ya funcionan.
  const revision = useDocReview({ documentId, version: versionVigente, bloques: bloquesActuales });

  /**
   * Revisar guarda primero, por lo mismo que la lectura en voz alta: el corrector mira el
   * documento GUARDADO —que es lo que hace que el permiso y la versión sean los del
   * documento y no los que declare el cliente—, así que con una edición esperando el
   * debounce se revisaba el texto anterior. Metías una falta, revisabas, y no aparecía.
   */
  const revisarDoc = useCallback(async () => {
    try {
      await guardarYa?.();
    } catch {
      // Si el guardado falla ya se ve en su indicador; revisar lo que hay en la base es
      // lo mejor que se puede hacer con eso.
    }
    await revision.revisar();
  }, [guardarYa, revision]);
  /** Lo que escribes tú en la tarjeta cuando ninguna sugerencia sirve. */
  const [propia, setPropia] = useState("");
  const capaRev = useRef<HTMLDivElement | null>(null);
  const rafRev = useRef(0);

  const limpiarRevision = useCallback(() => {
    if (rafRev.current) cancelAnimationFrame(rafRev.current);
    rafRev.current = 0;
    capaRev.current?.remove();
    capaRev.current = null;
  }, []);

  /** Repinta todos los hallazgos. Se llama al entrar, al cambiar la lista y al scrollear. */
  const pintarRevision = useCallback(() => {
    // El subrayado NO depende del modo revisión: Word y Docs marcan las faltas siempre, y
    // el modo revisión es sólo el recorrido. Verlas es lo que hace que el corrector sirva
    // mientras escribes; lo que la gente apaga de Grammarly son las reescrituras de
    // estilo, no que le señalen una falta de ortografía.
    if (!editor || !revision.hallazgos.length) return limpiarRevision();
    let capaEl = capaRev.current;
    if (!capaEl) {
      capaEl = document.createElement("div");
      capaEl.dataset.gtRevision = "1";
      // Mismo z-index que la marca de lectura y por la misma razón: el panel expandido es
      // z-[100] y esta capa vive en `document.body`, así que compite con él.
      capaEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:120";
      document.body.appendChild(capaEl);
      capaRev.current = capaEl;
    }
    capaEl.textContent = "";
    const actualId = revision.actual?.id;
    for (const h of revision.hallazgos) {
      const nodo = document.querySelector<HTMLElement>(`.gt-doc [data-id="${CSS.escape(h.blockId)}"]`);
      if (!nodo || !document.contains(nodo)) continue;
      const rango = rangoEnBloque(nodo, h.offset, h.length);
      if (!rango) continue;
      // Un rect por línea: una palabra partida al final del renglón son dos.
      for (const r of Array.from(rango.getClientRects())) {
        if (!r.width) continue;
        const d = document.createElement("div");
        d.className = h.id === actualId ? "gt-ortografia gt-ortografia-actual" : "gt-ortografia";
        d.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        capaEl.appendChild(d);
      }
    }
  }, [editor, revision.revisando, revision.hallazgos, revision.actual, limpiarRevision]);

  // Se repinta en scroll y resize, NO en un rAF continuo: con decenas de hallazgos,
  // recalcular sus rangos 60 veces por segundo se come el scroll.
  useEffect(() => {
    pintarRevision();
    if (!revision.hallazgos.length) return;
    const box = caja();
    let pendiente = false;
    const alMover = () => {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(() => {
        pendiente = false;
        pintarRevision();
      });
    };
    box?.addEventListener("scroll", alMover, { passive: true });
    window.addEventListener("resize", alMover);
    return () => {
      box?.removeEventListener("scroll", alMover);
      window.removeEventListener("resize", alMover);
    };
  }, [pintarRevision, revision.hallazgos.length, caja]);

  useEffect(() => () => limpiarRevision(), [limpiarRevision]);

  /**
   * Clic en una palabra subrayada → su tarjeta.
   *
   * Es EL gesto de Word y Docs: la gente corrige así casi siempre, y el panel queda para
   * la pasada final. Va delegado en el documento y no en la capa porque la capa es
   * `pointer-events:none` a propósito — si capturara el cursor, no podrías poner el
   * cursor de texto sobre una palabra marcada.
   *
   * Se resuelve por COORDENADAS contra los rangos de los hallazgos de ese bloque: es lo
   * único fiable cuando la palabra puede estar partida en dos líneas.
   */
  useEffect(() => {
    const raiz = scroller.current;
    if (!raiz || !revision.hallazgos.length) return;
    const alClic = (e: MouseEvent) => {
      const nodo = (e.target as Element | null)?.closest?.(".gt-doc [data-id]") as HTMLElement | null;
      const id = nodo?.getAttribute("data-id");
      if (!id) return;
      const candidatos = revision.hallazgos.filter((h) => h.blockId === id);
      if (!candidatos.length) return;
      for (const h of candidatos) {
        const rango = rangoEnBloque(nodo!, h.offset, h.length);
        if (!rango) continue;
        const dentro = Array.from(rango.getClientRects()).some(
          (r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom,
        );
        if (!dentro) continue;
        const i = revision.hallazgos.findIndex((x) => x.id === h.id);
        if (i >= 0) {
          revision.setActual(i);
          revision.entrar();
        }
        return;
      }
    };
    raiz.addEventListener("click", alClic);
    return () => raiz.removeEventListener("click", alClic);
  }, [revision]);

  /**
   * Lleva la vista al hallazgo actual.
   *
   * El contenedor sale de `caja()`, que es el resolutor que ya usa el resto del archivo:
   * este div NO scrollea (no está acotado), así que preguntarle a él deja el scroll en
   * nada — y entonces el párrafo se queda fuera de la pantalla y su subrayado tampoco se
   * pinta. Los dos síntomas, una sola causa.
   *
   * Depende del `id` y no del objeto: `hallazgos[actual]` es una referencia nueva en cada
   * render y el efecto se dispararía sin parar.
   */
  const idActual = revision.actual?.id;
  useEffect(() => setPropia(""), [idActual]);
  useEffect(() => {
    const h = revision.actual;
    if (!h || !revision.revisando) return;
    const nodo = document.querySelector<HTMLElement>(`.gt-doc [data-id="${CSS.escape(h.blockId)}"]`);
    const box = caja();
    if (!nodo || !box) return;
    const r = nodo.getBoundingClientRect();
    const base = box.getBoundingClientRect();
    const destino = box.scrollTop + (r.top - base.top) - box.clientHeight / 2 + r.height / 2;
    box.scrollTo({ top: Math.max(0, destino), behavior: "smooth" });
    // El scroll suave tarda; el listener repinta durante el viaje, pero se refuerza al
    // final por si el destino ya estaba a la vista y no hubo evento de scroll.
    const t = setTimeout(() => pintarRevision(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idActual, revision.revisando, caja]);

  /**
   * Aplica una sugerencia al documento.
   *
   * Reconstruye el inline content del bloque con el tramo sustituido, así que el uuid y el
   * formato del resto sobreviven. Antes comprueba que el texto sigue siendo el que el
   * corrector vio: si el documento cambió por debajo, se descarta el hallazgo en vez de
   * escribir sobre lo que ahora haya ahí.
   */
  const aplicarSugerencia = useCallback(
    (h: Hallazgo, sugerencia: string) => {
      if (!editor) return;
      const docu = (editor.document ?? []) as DocBlock[];
      const buscar = (list: DocBlock[]): DocBlock | null => {
        for (const b of list) {
          if (b.id === h.blockId) return b;
          const hijo = b.children?.length ? buscar(b.children) : null;
          if (hijo) return hijo;
        }
        return null;
      };
      const bloque = buscar(docu);
      if (!bloque) return;
      const mapa = blockTextMapped(bloque);
      if (mapa.texto.slice(h.offset, h.offset + h.length) !== h.palabra) return; // ya no es lo que era
      const r = rangoCrudo(mapa, h.offset, h.length);
      if (!r || !r.unSoloRun) return;
      const nuevo = reemplazarEnBloque(bloque, r.desde, r.hasta, sugerencia);
      editor.updateBlock(h.blockId as never, { content: nuevo.content as never });
      revision.resolver(h, sugerencia.length - h.length);
    },
    [editor, revision],
  );

  /**
   * Aplica la misma corrección a TODAS las apariciones de esa palabra.
   *
   * Se recorre de atrás hacia delante dentro de cada bloque: corregir desplaza los offsets
   * de lo que viene después, y empezando por el final ese desplazamiento no llega a
   * importar. (`resolver` ya recoloca los que quedan, pero aquí se aplican varias seguidas
   * sobre el mismo texto y el orden es lo que lo hace fiable.)
   */
  const cambiarTodas = useCallback(
    (h: Hallazgo, sugerencia: string) => {
      const todos = [...revision.iguales(h)].sort(
        (a, b) => (a.blockId === b.blockId ? b.offset - a.offset : 0),
      );
      for (const x of todos) aplicarSugerencia(x, sugerencia);
    },
    [revision, aplicarSugerencia],
  );

  // ── De un NODO a su índice de bloque ────────────────────────────────────────
  //
  // `marcarIndices` hace el camino de ida (índice → id → nodo). Esto es la vuelta, y es lo
  // que permite empezar a leer POR DONDE EL USUARIO SEÑALA en vez de siempre desde arriba.
  const indiceDeNodo = useCallback(
    (n: Node | null): number | null => {
      if (!n || !editor) return null;
      const el = (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest("[data-id]");
      const id = el?.getAttribute("data-id");
      if (!id) return null;
      const i = ((editor.document ?? []) as DocBlock[]).findIndex((b) => b.id === id);
      return i >= 0 ? i : null;
    },
    [editor],
  );

  // Al abrir el documento se revisa en segundo plano: las faltas aparecen subrayadas sin
  // que haya que pedirlo, como en cualquier procesador de textos. `revisar(true)` cuenta y
  // subraya, pero NO enciende el modo revisión — ése sigue siendo un gesto explícito.
  const yaRevisado = useRef(false);
  useEffect(() => {
    if (!documentId || streaming || yaRevisado.current) return;
    yaRevisado.current = true;
    void revision.revisar(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, streaming]);

  // Precalentado: la caja de voz hiberna a los 900 s y el primer play pagaría el resume
  // encima de la síntesis. Se despierta al abrir el documento; la guarda de los 5 minutos
  // vive en el servidor, así que esto no puede convertirse en una tormenta de peticiones.
  useEffect(() => {
    if (!documentId || streaming) return;
    void fetch("/api/tts-warm", { method: "POST" }).catch(() => {});
  }, [documentId, streaming]);

  // ── Bocina por párrafo, al pasar el ratón ───────────────────────────────────
  //
  // Va por delegación sobre el contenedor y NO por el side menu de BlockNote: ése se apaga
  // con `editable=false`, y leer en voz alta un documento que sólo puedes VER (una versión
  // vieja, un documento compartido) es justo uno de los casos que se pidieron.
  //
  // Va al margen DERECHO del párrafo: el izquierdo ya es de BlockNote (el `+` y el asa de
  // arrastre), y ahí la bocina se les encimaba.
  const [bocina, setBocina] = useState<{ i: number; top: number; left: number } | null>(null);
  const bocinaOff = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** El nodo del párrafo al que apunta, para recolocarla cuando el documento scrollea. */
  const bocinaNodo = useRef<HTMLElement | null>(null);
  // Ir hacia la bocina obliga a salir del párrafo, y el botón vive FUERA del contenedor
  // (es `fixed`), así que ocultarla en cuanto el cursor deja el texto la volvía imposible
  // de pulsar: desaparecía justo al ir a por ella. Se apaga con retardo, y entrar en el
  // botón cancela el retardo.
  //
  // ⚠️ El flag `sobreBocina` no es redundante con cancelar el temporizador. Al ir del
  // texto al botón se disparan DOS eventos —`pointerenter` del botón y `mouseleave` del
  // contenedor— y el segundo llega después: cancelar en el `enter` no servía de nada,
  // porque el `leave` volvía a programar el apagado y ya no quedaba nadie para cancelarlo.
  // La bocina se desvanecía justo con el cursor encima.
  const sobreBocina = useRef(false);
  /** Cierto cuando la bocina visible es la del párrafo activo: ésa no se autooculta. */
  const bocinaPegada = useRef(false);
  const cancelarOcultar = useCallback(() => {
    if (bocinaOff.current) clearTimeout(bocinaOff.current);
    bocinaOff.current = null;
  }, []);
  const ocultarLuego = useCallback(() => {
    if (bocinaOff.current) return;
    bocinaOff.current = setTimeout(() => {
      bocinaOff.current = null;
      // La del párrafo activo NO se va: mientras algo suena, es el stop que tienes a mano.
      if (!sobreBocina.current && !bocinaPegada.current) setBocina(null);
      // Un segundo entero: el recorrido del texto al botón pasa por zona muerta, y que se
      // apague a medio camino es lo que hacía imposible pulsarla. Sobra tiempo antes de que
      // estorbe — se va sola en cuanto el cursor toca otro párrafo.
    }, 1000);
  }, []);
  useEffect(() => {
    const raiz = scroller.current;
    if (!raiz || !documentId || streaming) return;
    const sobre = (e: MouseEvent) => {
      let el = (e.target as Element | null)?.closest?.(".gt-doc [data-id]") as HTMLElement | null;
      // El hover es de la FILA, no de las letras. Un párrafo de dos palabras deja media
      // hoja "vacía" a su derecha, y ahí el cursor está claramente sobre ese párrafo: se
      // resuelve el bloque por la ALTURA del cursor, mirando el centro de la columna de
      // texto. Sin esto, la bocina parpadeaba al mover el ratón por los márgenes.
      if (!el) {
        const art = raiz.querySelector("article");
        if (art) {
          const r = art.getBoundingClientRect();
          const bajo = document.elementFromPoint(Math.round(r.left + r.width / 2), e.clientY);
          el = (bajo?.closest?.(".gt-doc [data-id]") as HTMLElement | null) ?? null;
        }
      }
      const i = el ? indiceDeNodo(el) : null;
      if (i == null || !el) {
        ocultarLuego();
        return;
      }
      cancelarOcultar();
      bocinaNodo.current = el;
      const r = el.getBoundingClientRect();
      setBocina((prev) =>
        prev && prev.i === i ? prev : { i, top: Math.round(r.top + 1), left: Math.round(r.right + 10) },
      );
    };
    const fuera = () => {
      ocultarLuego();
    };
    raiz.addEventListener("mousemove", sobre, { passive: true });
    raiz.addEventListener("mouseleave", fuera);
    return () => {
      raiz.removeEventListener("mousemove", sobre);
      raiz.removeEventListener("mouseleave", fuera);
      cancelarOcultar();
    };
  }, [documentId, streaming, indiceDeNodo, cancelarOcultar]);

  // Al scrollear, el rect guardado deja de valer, así que la bocina se RECOLOCA sobre su
  // párrafo. Antes se escondía, y eso la hacía inservible durante la lectura: cada cambio
  // de párrafo scrollea solo, así que la bocina que ibas a pulsar desaparecía bajo el dedo
  // y el clic caía al vacío. Sólo se esconde si su párrafo se fue de la pantalla.
  useEffect(() => {
    if (!bocina) return;
    const box = caja();
    if (!box) return;
    let pendiente = false;
    const recolocar = () => {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(() => {
        pendiente = false;
        const el = bocinaNodo.current;
        if (!el || !document.contains(el)) return setBocina(null);
        const r = el.getBoundingClientRect();
        const caj = box.getBoundingClientRect();
        if (r.bottom < caj.top || r.top > caj.bottom) return setBocina(null);
        const top = Math.round(r.top + 1);
        const left = Math.round(r.right + 10);
        setBocina((prev) => (prev && prev.top === top && prev.left === left ? prev : prev && { ...prev, top, left }));
      });
    };
    box.addEventListener("scroll", recolocar, { passive: true });
    window.addEventListener("resize", recolocar);
    return () => {
      box.removeEventListener("scroll", recolocar);
      window.removeEventListener("resize", recolocar);
    };
  }, [bocina, caja]);

  // ── Qué hay seleccionado ────────────────────────────────────────────────────
  //
  // Se lee de la selección del NAVEGADOR y no de `editor.getSelection()` por lo mismo que
  // la bocina: en sólo-lectura no hay selección de editor, pero el usuario sí puede
  // seleccionar texto con el ratón.
  const [sel, setSel] = useState<{ desde: number; hasta: number } | null>(null);
  useEffect(() => {
    if (!documentId || streaming) return;
    const mirar = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) return setSel(null);
      const dentro = scroller.current?.contains(s.anchorNode ?? null);
      if (!dentro) return setSel(null);
      const a = indiceDeNodo(s.anchorNode);
      const b = indiceDeNodo(s.focusNode);
      if (a == null || b == null) return setSel(null);
      const desde = Math.min(a, b);
      const hasta = Math.max(a, b);
      setSel((prev) => (prev && prev.desde === desde && prev.hasta === hasta ? prev : { desde, hasta }));
    };
    document.addEventListener("selectionchange", mirar);
    mirar();
    return () => document.removeEventListener("selectionchange", mirar);
  }, [documentId, streaming, indiceDeNodo]);

  // Los bloques que el agente acaba de tocar, resueltos de sus ALIAS contra el documento
  // que este editor tiene AHORA — que es exactamente el que el agente vio, así que los
  // alias casan. Marca en el momento del patch, sin esperar a que el server publique ni a
  // que el panel se reabra: ése era el orden que se estorbaba a sí mismo.
  useEffect(() => {
    if (!editor || !patchRefs?.length) return;
    const docu = (editor.document ?? []) as DocBlock[];
    const table = aliasTable(docu);
    const indices = patchRefs
      .map((ref) => table.get(ref) ?? (docu.some((b) => b.id === ref) ? ref : null))
      .filter((id): id is string => !!id)
      .map((id) => docu.findIndex((b) => b.id === id))
      .filter((i) => i >= 0);
    if (indices.length) señalar(indices);
  }, [editor, patchRefs, señalar]);

  // Fallback: el panel se abrió DESPUÉS del turno (no había editor montado cuando llegó el
  // patch). Ahí los ids persistidos del sobre son lo único que dice qué cambió.
  useEffect(() => {
    if (!editor || !highlightIds?.length) return;
    const clave = highlightIds.join(",");
    if (yaSenalado.has(clave)) return;
    yaSenalado.add(clave);
    const docu = (editor.document ?? []) as DocBlock[];
    const indices = highlightIds.map((id) => docu.findIndex((b) => b.id === id)).filter((i) => i >= 0);
    if (indices.length) señalar(indices);
  }, [editor, highlightIds, señalar]);

  const notify = useCallback(() => {
    if (!onChange) return;
    // La bandera `applying` NO basta, y esto costó caro: se libera en un microtask, pero
    // ProseMirror notifica sus cambios DESPUÉS. Resultado: las escrituras del propio
    // reconciliador se contaban como edición humana → autosave → versión nueva →
    // refresh → el reconciliador vuelve a escribir → reemplaza los nodos del documento…
    // en bucle. Se veía como que el resaltado se marcaba sobre nodos que se desprendían
    // un frame después (`visible:false` una y otra vez), y además llenaba el historial
    // de versiones que nadie pidió.
    //
    // La comparación de FIRMAS es determinista: si el documento del editor es idéntico a
    // lo último que aplicamos, esto es nuestro propio eco, no una edición.
    const actual = (editor.document as DocBlock[]).map(blockSignature).join(" ");
    if (applying.current || actual === seen.current) return;
    seen.current = actual; // lo escribió una persona: pasa a ser la referencia
    // Un hallazgo sobre un párrafo que la persona acaba de reescribir ya no vale: señalar
    // una falta en un texto que ya no existe es peor que no señalar nada. La invalidación
    // es por CONTENIDO, así que basta con avisar.
    revision.caducar();
    onChange(editor.document as DocBlock[]);
  }, [editor, onChange, revision]);

  // ⚠️ Aquí hubo un listener de `input` que llamaba a `notify` como "segundo canal" de
  // guardado, puesto mientras se buscaba por qué no se guardaba. **Era una hipótesis falsa
  // y salía caro**: `notify` recorre el documento entero calculando firmas, así que teclear
  // costaba dos pasadas O(documento) por pulsación y en un documento largo el editor se
  // atragantaba y perdía caracteres. El fallo real estaba en el servidor (un documento de
  // un DM no tenía canal y `updateDocBlocks` lanzaba antes de escribir). `editor.onChange`
  // siempre funcionó; no le hace falta compañía.
  useEffect(() => {
    if (!editor || !editable) return;
    return editor.onChange(notify);
  }, [editor, editable, notify]);

  const live = editable && !streaming;
  /** ¿El párrafo que la bocina señala es justo el que se está leyendo? */
  // ── La bocina es el control principal de la lectura ─────────────────────────
  //
  // La barra de arriba sigue ahí, pero el gesto natural es actuar sobre el párrafo que
  // estás mirando. Así que en el párrafo ACTIVO la bocina refleja el estado real y hace lo
  // que toca: si viene en camino, spinner; si suena, stop; si está en pausa, reanudar.
  // En cualquier otro párrafo es siempre un play que salta la lectura ahí.
  const bocinaActiva = !!bocina && (leyendoI === bocina.i || pedidoI === bocina.i);
  const cargandoAqui = bocinaActiva && voz.estado === "cargando";
  // Con el panel estrecho los botones enseñan sólo su icono: el texto no cabe y se salía
  // del panel, cortado a media palabra. El `title` sigue diciendo qué hace cada uno.
  const estrecho = (posBoton?.ancho ?? 999) < 560;
  /**
   * ¿Hay panel donde pintar los controles flotantes?
   *
   * Mientras el panel se cierra, su ancho se anima hasta cero. Por debajo de 200px no cabe
   * ni una barra, y dejarlas ahí las amontona contra el borde justo cuando el documento ya
   * se está yendo: se retiran y el cierre queda limpio.
   */
  const hayPanel = !!posBoton && posBoton.ancho > 200;
  const sonando = bocinaActiva && voz.estado === "leyendo";
  const pausadoAqui = bocinaActiva && voz.estado === "pausa";
  bocinaPegada.current = bocinaActiva && voz.estado !== "parado";

  return (
    // `relative` para el botón flotante; el que scrollea es el hijo, no este.
    <div className="relative min-h-0 flex-1">
      {/* `gt-doc` acota el CSS de Mantine: BlockNote trae estilos globales y el panel
          vive en tema oscuro. Todo lo del editor queda dentro de esta clase. */}
      <div
        ref={scroller}
        className="gt-doc h-full overflow-auto bg-surface-3 p-4 thin-scroll sm:p-6"
      >
        <div className="mx-auto max-w-[8.5in]">
          <article className="min-h-[60vh] rounded-sm bg-white py-10 text-black shadow-md sm:py-14">
            <BlockNoteView
              editor={editor}
              editable={live}
              theme="light"
              // El corrector del NAVEGADOR se apaga: marca nombres propios como faltas
              // (Perdix, Nüwa, Areópago), no ve gramática, no propone la corrección donde
              // la lees y su diccionario depende de qué idioma tenga instalada cada
              // máquina — el mismo documento se subraya distinto en cada equipo. La
              // revisión la hace LanguageTool, que sí es igual para todos. Es lo que hacen
              // Word y Google Docs con el suyo.
              spellCheck={false}
              // El menú de formato y el de slash sólo estorban mientras el agente
              // escribe (y ahí el documento no es editable de todos modos).
              formattingToolbar={live}
              slashMenu={live}
            />
            {streaming ? (
              <span className="ml-14 inline-block h-4 w-[3px] animate-pulse bg-brand align-text-bottom" />
            ) : null}
          </article>
        </div>
      </div>

      {/* Leer en voz alta. Arriba a la derecha del documento y NO en el chat: lo que se
          está leyendo es el documento, y el control tiene que estar donde está el texto
          que va resaltándose (es el pedido literal del demo: "como en Word").

          ⚠️ `fixed` anclado al rect del contenedor VISIBLE, igual que el resto de flotantes
          de este archivo, y por la misma razón de siempre: este div no está acotado, así
          que mide el alto del documento entero y un `absolute top-3` se va con el scroll.
          Se veía como que la barra "no era superior": para detener la lectura había que
          volver hasta arriba del documento. */}
      {documentId && !streaming && hayPanel ? (
        <div
          style={{ position: "fixed", top: posBoton.arriba, right: posBoton.derecha }}
          className="z-[70] flex items-center gap-1 rounded-full border border-border bg-surface/95 px-1.5 py-1 shadow-lg backdrop-blur"
        >
          {!voz.leyendo && voz.estado !== "pausa" ? (
            sel ? (
              // Con texto seleccionado son DOS lecturas distintas y las dos se piden:
              // revisar el párrafo que marcaste, o retomar la lectura desde ahí.
              <>
                <button
                  type="button"
                  onClick={() => void leerDesde(sel.desde, sel.hasta)}
                  aria-label={t("Leer la selección")}
                  title={t("Leer la selección")}
                  className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-ink transition hover:text-brand"
                >
                  <Volume2 size={14} />
                  {estrecho ? null : t("Leer la selección")}
                </button>
                <button
                  type="button"
                  onClick={() => void leerDesde(sel.desde)}
                  aria-label={t("Leer desde aquí")}
                  title={t("Leer desde aquí")}
                  className="rounded-full p-1 text-muted transition hover:text-brand"
                >
                  <ArrowDown size={14} />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void leerDesde()}
                // El cebo: al llegar el cursor al botón se pide ya la primera frase, que
                // es ~1.6 s de síntesis. Para cuando el dedo hace clic, el audio está.
                onPointerEnter={voz.cebar}
                onFocus={voz.cebar}
                aria-label={t("Leer en voz alta")}
                title={t("Leer en voz alta")}
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-ink transition hover:text-brand"
              >
                <Volume2 size={14} />
                {estrecho ? null : t("Leer en voz alta")}
              </button>
            )
          ) : (
            <>
              <button
                type="button"
                onClick={() => voz.saltar(-1)}
                aria-label={t("Párrafo anterior")}
                title={t("Párrafo anterior")}
                className="rounded-full p-1 text-ink transition hover:text-brand"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={voz.estado === "pausa" ? voz.reanudar : voz.pausar}
                aria-label={voz.estado === "pausa" ? t("Reanudar") : t("Pausar")}
                title={voz.estado === "pausa" ? t("Reanudar") : t("Pausar")}
                className="rounded-full p-1 text-ink transition hover:text-brand"
              >
                {voz.estado === "cargando" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : voz.estado === "pausa" ? (
                  <Play size={14} />
                ) : (
                  <Pause size={14} />
                )}
              </button>
              <button
                type="button"
                onClick={() => voz.saltar(1)}
                aria-label={t("Párrafo siguiente")}
                title={t("Párrafo siguiente")}
                className="rounded-full p-1 text-ink transition hover:text-brand"
              >
                <ChevronRight size={14} />
              </button>
              {/* La velocidad cicla en vez de abrir un menú: son tres valores y el control
                  vive encima del documento, donde un desplegable estorba. */}
              <button
                type="button"
                onClick={() => voz.setVelocidad((v) => (v >= 1.5 ? 0.75 : v >= 1.25 ? 1.5 : v >= 1 ? 1.25 : 1))}
                aria-label={t("Velocidad")}
                title={t("Velocidad")}
                className="rounded-full px-1.5 py-1 text-[11px] font-semibold tabular-nums text-muted transition hover:text-brand"
              >
                {voz.velocidad}×
              </button>
              <button
                type="button"
                onClick={voz.parar}
                aria-label={t("Detener la lectura")}
                title={t("Detener la lectura")}
                className="rounded-full p-1 text-ink transition hover:text-brand"
              >
                {/* Sólido y no de contorno: un cuadrito hueco de 13px se lee como una
                    casilla vacía, no como el stop de un reproductor. */}
                <Square size={12} strokeWidth={0} className="fill-current" />
              </button>
            </>
          )}
          {voz.error ? (
            <span className="px-1.5 text-[11px] text-red-400">{t(voz.error)}</span>
          ) : null}
        </div>
      ) : null}

      {/* ── Revisión ortográfica ──────────────────────────────────────────────
          Debajo de la de lectura y con la misma ancla: son los dos controles del
          documento y tienen que vivir juntos.

          Fuera del modo revisión es sólo un contador — el documento se lee LIMPIO y tú
          decides cuándo mirar las sugerencias. Ése es el punto entero del diseño: lo que
          la gente apaga de los correctores es el subrayado que interrumpe. */}
      {documentId && !streaming && hayPanel ? (
        <div
          style={{ position: "fixed", top: posBoton.arriba + 44, right: posBoton.derecha }}
          className="z-[70] flex items-center gap-1 rounded-full border border-border bg-surface/95 px-1.5 py-1 shadow-lg backdrop-blur"
        >
          {!revision.revisando ? (
            <button
              type="button"
              onClick={() => void revisarDoc()}
              disabled={revision.estado === "revisando"}
              aria-label={t("Revisar ortografía")}
              title={t("Revisar ortografía")}
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-ink transition hover:text-brand disabled:opacity-60"
            >
              {revision.estado === "revisando" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <SpellCheck size={14} />
              )}
              {revision.total > 0 && revision.estado === "listo"
                ? estrecho
                  ? String(revision.total)
                  : t("{n} sugerencias").replace("{n}", String(revision.total))
                : estrecho
                  ? null
                  : t("Revisar ortografía")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => revision.ir(-1)}
                disabled={revision.indice <= 0}
                aria-label={t("Anterior")}
                title={t("Anterior")}
                className="rounded-full p-1 text-ink transition hover:text-brand disabled:opacity-40"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-0.5 text-[11px] font-semibold tabular-nums text-muted">
                {revision.total ? revision.indice + 1 : 0}/{revision.total}
              </span>
              <button
                type="button"
                onClick={() => revision.ir(1)}
                disabled={revision.indice >= revision.total - 1}
                aria-label={t("Siguiente")}
                title={t("Siguiente")}
                className="rounded-full p-1 text-ink transition hover:text-brand disabled:opacity-40"
              >
                <ChevronRight size={14} />
              </button>
              {revision.total === 0 && revision.estado === "listo" ? (
                <>
                  <span className="px-1 text-[11px] font-medium text-emerald-500">
                    {t("Sin sugerencias")}
                  </span>
                  {/* Sin esto, terminar la revisión dejaba la barra en 0/0 y la única
                      salida era la X: escribías algo nuevo y no había forma de volver a
                      revisar sin salir y entrar. */}
                  <button
                    type="button"
                    onClick={() => void revisarDoc()}
                    aria-label={t("Revisar de nuevo")}
                    title={t("Revisar de nuevo")}
                    className="rounded-full p-1 text-ink transition hover:text-brand"
                  >
                    <SpellCheck size={14} />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={revision.salir}
                aria-label={t("Salir de la revisión")}
                title={t("Salir de la revisión")}
                className="rounded-full p-1 text-ink transition hover:text-brand"
              >
                <X size={14} />
              </button>
            </>
          )}
          {revision.error ? (
            <span className="px-1.5 text-[11px] text-red-400">{t(revision.error)}</span>
          ) : null}
        </div>
      ) : null}

      {/* La tarjeta del hallazgo. Va anclada al panel y no flotando junto a la palabra:
          una tarjeta pegada al texto tapa justo lo que tienes que leer para decidir. */}
      {revision.revisando && revision.actual && hayPanel ? (
        <div
          style={{
            position: "fixed",
            top: posBoton.arriba + 88,
            right: posBoton.derecha,
            // Un panel estrecho manda sobre el ancho de la tarjeta: si no, se sale por el
            // lado y la sugerencia queda fuera de la pantalla.
            maxWidth: Math.max(200, Math.min(320, posBoton.ancho - 24)),
          }}
          className="z-[70] rounded-xl border border-border bg-surface/98 p-3 shadow-xl backdrop-blur"
        >
          <p className="text-xs text-muted">{revision.actual.mensaje}</p>
          <p className="mt-1.5 text-sm text-ink">
            <span className="rounded bg-amber-500/20 px-1 font-medium">{revision.actual.palabra}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {revision.actual.sugerencias.length ? (
              revision.actual.sugerencias.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => aplicarSugerencia(revision.actual!, s)}
                  className="rounded-md bg-ink px-2 py-0.5 text-xs font-semibold text-surface transition hover:opacity-90"
                >
                  {s}
                </button>
              ))
            ) : (
              // Hay reglas que señalan sin proponer (una frase demasiado larga, por
              // ejemplo). Decirlo es más honesto que ofrecer un botón que no hace nada.
              <span className="text-xs text-muted">{t("Sin sugerencia automática")}</span>
            )}
            <button
              type="button"
              // ⚠️ Ignorar es PARA SIEMPRE: quita todas las apariciones y manda la palabra
              // al diccionario. Hubo un "ignorar sólo esta vez" separado, copiado de Word,
              // y en uso real no tenía sentido: allí el documento es local y la sesión dura
              // horas; aquí se refresca cada poco, y lo que uno quiere decir SIEMPRE es
              // "esto no es una falta, no me lo vuelvas a preguntar". Con la versión
              // efímera, cada recarga devolvía las mismas palabras.
              onClick={() => revision.resolver(revision.actual!, 0, true)}
              className="rounded-md px-2 py-0.5 text-xs text-muted transition hover:text-ink"
              title={t("Ignorar esta palabra en todo el documento")}
            >
              {t("Ignorar")}
            </button>
          </div>

          {/* Tu propia corrección. Word lo tiene en su panel y ahorra el viaje "cierro la
              tarjeta, busco la palabra en el documento, la edito a mano" — que además te
              hace perder el sitio en un escrito largo. */}
          <form
            className="mt-2 flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const v = propia.trim();
              if (!v || !revision.actual) return;
              aplicarSugerencia(revision.actual, v);
              setPropia("");
            }}
          >
            <input
              value={propia}
              onChange={(e) => setPropia(e.target.value)}
              placeholder={t("Escribir otra…")}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface-3 px-2 py-1 text-xs text-ink outline-none focus:border-brand"
            />
            <button
              type="submit"
              disabled={!propia.trim()}
              className="rounded-md bg-ink px-2 py-1 text-xs font-semibold text-surface transition hover:opacity-90 disabled:opacity-40"
            >
              {t("Aplicar")}
            </button>
          </form>

          {/* Las acciones "para todas" van abajo y en tono menor: son las que más ahorran
              y las que peor se sienten si se disparan por accidente. Sólo aparecen cuando
              la palabra sale más de una vez, que es cuando significan algo. */}
          {/* "Ignorar todas" está SIEMPRE, aunque el contador vea una sola aparición: es
              la acción que uno busca ante un nombre propio, y además lo manda al
              diccionario para que no vuelva a preguntarlo mañana. "Cambiar todas" sí
              depende de que haya más de una, porque si no es lo mismo que "Cambiar". */}
          {/* Sólo cuando la palabra se repite: con una sola aparición, "Cambiar todas" es
              idéntico a "Cambiar" y la fila quedaría siendo un borde vacío. */}
          {revision.iguales(revision.actual).length > 1 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-[11px] text-muted">
              <span>
                {t("{n} veces en el documento").replace(
                  "{n}",
                  String(revision.iguales(revision.actual).length),
                )}
              </span>
              {revision.actual.sugerencias[0] ? (
                <button
                  type="button"
                  onClick={() => cambiarTodas(revision.actual!, revision.actual!.sugerencias[0])}
                  className="font-semibold text-brand transition hover:underline"
                >
                  {t("Cambiar todas")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* La bocina del párrafo bajo el cursor: empieza a leer AHÍ. Sin esto, la única
          lectura posible era desde el principio del documento, que en un escrito de 100
          bloques equivale a no poder elegir. */}
      {/* Si el párrafo señalado es el que SUENA, la bocina es un stop: ahí el gesto obvio
          es callar lo que estás oyendo, no volver a empezarlo. En cualquier otro párrafo
          sigue siendo un play, que además salta la lectura a ese punto. */}
      {/* Con texto seleccionado NO se pinta: ahí sale la barra de formato de BlockNote y las
          dos se disputan el mismo hueco (y el mismo apilamiento). Además, con una selección
          viva el gesto ya está en la barra de lectura, que ofrece leerla. */}
      {bocina && !streaming && !sel ? (
        <button
          type="button"
          style={{ position: "fixed", top: bocina.top, left: bocina.left }}
          // `onPointerDown` y no `onClick`: entre el down y el up puede llegar un scroll
          // automático de la lectura en curso, y un botón que se recoloca a media pulsación
          // no llega a emitir el click. Así la orden sale en cuanto se aprieta.
          onPointerDown={() => {
            if (sonando) return voz.parar();
            if (pausadoAqui) return voz.reanudar();
            void leerDesde(bocina.i);
          }}
          onPointerEnter={() => {
            sobreBocina.current = true;
            cancelarOcultar();
            voz.cebar();
          }}
          onPointerLeave={() => {
            sobreBocina.current = false;
            ocultarLuego();
          }}
          aria-label={
            sonando ? t("Detener la lectura") : pausadoAqui ? t("Reanudar") : t("Leer desde este párrafo")
          }
          title={
            sonando ? t("Detener la lectura") : pausadoAqui ? t("Reanudar") : t("Leer desde este párrafo")
          }
          // El blanco real es más grande que el círculo (`before:-inset-3`): con 20px de
          // icono en el margen, apuntarle era un ejercicio de puntería.
          // z-40: por encima del documento pero POR DEBAJO de los menús de BlockNote, que
          // se montan en su propio portal. La bocina es un atajo; un menú abierto manda.
          className="z-40 rounded-full border border-border bg-surface/95 p-1.5 text-muted shadow-sm backdrop-blur transition before:absolute before:-inset-3 before:content-[''] hover:text-brand"
        >
          {cargandoAqui ? (
            <Loader2 size={14} className="animate-spin" />
          ) : sonando ? (
            <Square size={12} strokeWidth={0} className="fill-current" />
          ) : pausadoAqui ? (
            <Play size={14} className="fill-current" />
          ) : (
            <Volume2 size={14} />
          )}
        </button>
      ) : null}

      {/* Autoguardado. Vive en la BARRA del panel, junto a los iconos (lo sube DocSurface
          por `onGuardado`), que es donde lo ponen Google Docs y Word y donde la gente lo
          busca. Esta copia flotante de abajo a la izquierda se queda sólo para cuando el
          editor se monta fuera del panel — ahí no hay barra donde pintarlo. */}
      {guardado ? (
        <div
          style={posBoton ? { position: "fixed", left: posBoton.left, top: posBoton.top } : undefined}
          className={`pointer-events-none z-40 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur transition ${
            guardado === "error"
              ? "border-red-500/40 bg-red-500/15 text-red-300"
              : "border-border bg-surface/95 text-muted"
          }`}
        >
          {guardado === "pendiente" ? (
            <>
              <Pencil size={12} />
              {t("Sin guardar")}
            </>
          ) : guardado === "guardando" ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              {t("Guardando…")}
            </>
          ) : guardado === "ok" ? (
            <>
              <Check size={12} className="text-emerald-500" />
              {t("Guardado")}
            </>
          ) : (
            <>
              <TriangleAlert size={12} />
              {t("No se pudo guardar")}
            </>
          )}
        </div>
      ) : null}

      {/* Ir al final. Sólo cuando NO estás abajo — si no, es un botón que no hace nada
          tapando el documento. Mientras el agente escribe además avisa de que sigue
          llegando texto más abajo. */}
      {/* Ir al principio. En un escrito de 100 bloques, volver a la comparecencia o al
          proemio es tan frecuente como bajar al final — y arrastrar la barra 15 pantallas
          no es una respuesta. Sólo aparece si NO estás arriba. */}
      {!alTope && posBoton ? (
        <button
          type="button"
          onClick={irAlPrincipio}
          aria-label={t("Ir al principio")}
          title={t("Ir al principio")}
          style={{ position: "fixed", left: posBoton.right, top: posBoton.top - 42 }}
          className="z-40 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-2 text-xs font-medium text-ink shadow-lg backdrop-blur transition hover:border-brand hover:text-brand"
        >
          <ArrowUp size={14} />
          {t("Ir al principio")}
        </button>
      ) : null}

      {!alFondo && posBoton ? (
        <button
          type="button"
          onClick={irAlFondo}
          aria-label={t("Ir al final")}
          title={t("Ir al final")}
          style={{ position: "fixed", left: posBoton.right, top: posBoton.top }}
          className="z-40 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-2 text-xs font-medium text-ink shadow-lg backdrop-blur transition hover:border-brand hover:text-brand"
        >
          <ArrowDown size={14} />
          {streaming ? t("Sigue escribiendo") : t("Ir al final")}
        </button>
      ) : null}
    </div>
  );
}
