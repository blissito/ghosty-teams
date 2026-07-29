import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Check, Loader2, Pencil, TriangleAlert } from "lucide-react";
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
import { aliasTable, blockSignature, type DocBlock } from "../lib/doc-blocks";
import { reconcile } from "../lib/doc-reconcile";

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
  /**
   * Posición del botón "ir al final", en coordenadas de pantalla.
   *
   * No puede ser `absolute` respecto al div del editor: ese div NO está acotado (el
   * contenedor del panel tiene overflow-auto pero no es flex container, así que `flex-1`
   * y `h-full` no lo limitan), así que mide el alto de TODO el documento —unos 14.800px
   * con 100 bloques— y un `bottom-5` cae 14.800px hacia abajo, fuera de la pantalla. El
   * botón existía y no se veía. Es la tercera vez que esta trampa muerde en este archivo.
   */
  const [posBoton, setPosBoton] = useState<{ left: number; right: number; top: number } | null>(null);

  const alFinal = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;

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
        // El botón se ancla a la esquina del contenedor VISIBLE, no del documento.
        const r = box.getBoundingClientRect();
        const p = { left: Math.round(r.left + 16), right: Math.round(r.right - 150), top: Math.round(r.bottom - 52) };
        setPosBoton((prev) =>
          prev && prev.left === p.left && prev.right === p.right && prev.top === p.top ? prev : p,
        );
      };
      box.addEventListener("scroll", on, { passive: true });
      window.addEventListener("resize", on);
      on();
    };
    enganchar();

    return () => {
      clearTimeout(t);
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
      capaEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:60";
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
      const seguir = () => {
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

  useEffect(() => () => { esperando.current?.(); limpiarMarca(); }, [limpiarMarca]);

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
    onChange(editor.document as DocBlock[]);
  }, [editor, onChange]);

  useEffect(() => {
    if (!editor || !editable) return;
    return editor.onChange(notify);
  }, [editor, editable, notify]);

  const live = editable && !streaming;

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

      {/* Autoguardado, abajo a la izquierda: discreto pero presente. El error NO se
          desvanece (lo quita el siguiente guardado bueno) — perder texto en silencio es
          lo peor que puede pasarle a un documento. */}
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
