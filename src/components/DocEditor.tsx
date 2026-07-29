import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
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
import { blockSignature, type DocBlock } from "../lib/doc-blocks";
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

const schema = withMultiColumn(BlockNoteSchema.create());
const dictionary = { ...blockNoteEn, multi_column: multiColumnLocales.en };

export default function DocEditor({
  blocks,
  markdown,
  editable,
  streaming,
  onChange,
  highlightIds,
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
    const el = caja();
    if (!el) return;
    const on = () => {
      const v = alFinal(el);
      pegado.current = v;
      setAlFondo((prev) => (prev === v ? prev : v));
    };
    el.addEventListener("scroll", on, { passive: true });
    on();
    return () => el.removeEventListener("scroll", on);
  }, [caja, editor]);

  /**
   * Lleva a la vista el primer bloque que cambió y los marca a todos como con
   * marcatextos, unos segundos.
   *
   * Sin esto la edición quirúrgica es invisible: el agente cambia una cláusula en un
   * documento de 74 KB y no hay forma de saber cuál. El aviso decía "1 ajuste" y la
   * persona se quedaba buscando a mano.
   *
   * **El resaltado NO puede vivir en el documento.** Es una clase en el DOM, no una
   * propiedad del bloque: así no entra en la verdad que se persiste ni puede aparecer en
   * el .docx que se descarga. Efímero por construcción, no por acordarse de limpiarlo.
   */
  const marcarCambios = useCallback((ids: string[]): boolean => {
    const cont = scroller.current;
    if (!cont || !ids.length) return false;

    // `data-id` aparece en DOS divs anidados de BlockNote (`bn-block-outer` y
    // `bn-block`). Se marca el de CONTENIDO cuando existe: el de fuera es un
    // envoltorio de layout y sus hijos le pintan su propio fondo encima, así que el
    // color se quedaba debajo, invisible.
    const nodos = ids
      .map((id) => {
        const outer = cont.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        return outer?.querySelector<HTMLElement>(".bn-block-content") ?? outer;
      })
      .filter((n): n is HTMLElement => !!n);
    if (!nodos.length) return false;

    // El que scrollea puede NO ser nuestro div (ver contenedorQueScrollea).
    const box = contenedorQueScrollea(nodos[0]) ?? cont;
    const rect = nodos[0].getBoundingClientRect();
    const base = box.getBoundingClientRect();
    const destino = box.scrollTop + (rect.top - base.top) - box.clientHeight / 2 + rect.height / 2;
    // Siempre suave: el viaje hasta el bloque es parte de la señal ("está por aquí"),
    // no un adorno. Saltar de golpe no dice dónde estaba.
    box.scrollTo({ top: Math.max(0, destino), behavior: "smooth" });
    // Tras mover la vista a mitad del documento ya no estamos abajo: si no se apunta,
    // el siguiente tick del autoscroll arrastraría de vuelta al final.
    pegado.current = false;
    setAlFondo(false);

    for (const n of nodos) {
      n.classList.remove("gt-cambio", "gt-cambio-fin");
      void n.offsetWidth;
      n.classList.add("gt-cambio");
    }
    // TRAZA: ¿este editor es el que se VE? Puede haber más de una instancia montada
    // (panel del room y del hilo); marcar la oculta se ve exactamente igual que no
    // marcar nada.
    requestAnimationFrame(() => {
      const n0 = nodos[0];
      const r = n0.getBoundingClientRect();
      const cs = getComputedStyle(n0);
      console.log("[doc:marca] pintado", {
        n: nodos.length,
        clase: n0.className,
        visible: n0.offsetParent !== null,
        enPantalla: r.top < window.innerHeight && r.bottom > 0 && r.width > 0,
        rect: { top: Math.round(r.top), alto: Math.round(r.height), ancho: Math.round(r.width) },
        bgImage: cs.backgroundImage.slice(0, 42),
        bgSize: cs.backgroundSize,
        animName: cs.animationName,
        animDur: cs.animationDuration,
        boxShadow: cs.boxShadow.slice(0, 40),
        opacity: cs.opacity,
        destino: Math.round(destino),
        scrollTop: Math.round(box.scrollTop),
      });
    });
    // Dos tiempos: a los 3s se pide el desvanecido (una transición, no una animación
    // — las animaciones están prohibidas globalmente cuando hay "reducir movimiento",
    // y por eso la marca no se veía nunca) y medio segundo después se limpia del todo.
    // Se queda puesto un rato: hay que poder mirarlo, no cazarlo.
    setTimeout(() => {
      nodos.forEach((n) => n.classList.add("gt-cambio-fin"));
      setTimeout(() => nodos.forEach((n) => n.classList.remove("gt-cambio", "gt-cambio-fin")), 600);
    }, 4000);
    return true;
  }, []);

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
    // ¿Es una ACTUALIZACIÓN o la primera pintada? En la primera todo es "nuevo" y
    // resaltar el documento entero no dice nada.
    const esActualizacion = seen.current !== "";
    seen.current = sig;
    // Ids de ANTES, para saber después qué bloques son nuevos. Se mira el documento del
    // editor y no lo que devuelve `reconcile`, porque así da igual qué haga BlockNote con
    // los ids que le pasamos: lo que se resalta es lo que de verdad quedó en pantalla.
    const antes = new Set(((editor.document ?? []) as DocBlock[]).map((b) => b.id));
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

        // Un cambio QUIRÚRGICO ya aplicado: llévame a él y márcalo. No mientras streamea
        // (ahí el texto crece por la cola en cada tick y el autoscroll ya lo sigue), ni en
        // la primera pintada. El tope evita convertir una reescritura completa en un
        // documento entero subrayado, que no señala nada.
        if (!streaming && esActualizacion) {
          const nuevos = ((editor.document ?? []) as DocBlock[])
            .map((b) => b.id)
            .filter((id): id is string => !!id && !antes.has(id));
          if (nuevos.length && nuevos.length <= 8) marcarCambios(nuevos);
        }
      });
    }
  }, [editor, blocks, markdown, streaming, caja]);

  // Señalar lo que cambió al ABRIR. El editor monta con su documento ya puesto, así que
  // no hay diff que hacer: los ids vienen dados.
  //
  // Se REINTENTA en vez de esperar un plazo fijo: BlockNote pinta sus nodos cuando puede,
  // y en un documento de 75 KB eso tarda más que cualquier número que uno elija. Sin
  // reintento el querySelector no encontraba nada y fallaba en silencio.
  useEffect(() => {
    // TRAZA temporal (2026-07-29).
    console.log("[doc:marca] efecto", { editor: !!editor, highlightIds, yaVisto: highlightIds ? yaSenalado.has(highlightIds.join(",")) : null });
    if (!editor || !highlightIds?.length) return;
    const clave = highlightIds.join(",");
    if (yaSenalado.has(clave)) return;

    // Los ids se resuelven contra el documento que el EDITOR dice tener, no contra los
    // que le pasamos. Que `initialContent` conserve los ids no está garantizado —el
    // headless sí lo hace, el de React no lo he comprobado— y si los re-acuña, buscar
    // por el id de origen no encuentra nada y el resaltado falla mudo (que es justo lo
    // que pasaba). Por POSICIÓN es correcto en los dos casos.
    const resolverIds = (): string[] => {
      const suyos = (editor.document ?? []) as DocBlock[];
      const propios = new Set(suyos.map((b) => b.id).filter(Boolean) as string[]);
      // Camino normal: el editor conservó los ids.
      const directos = highlightIds.filter((id) => propios.has(id));
      if (directos.length) return directos;
      // Los re-acuñó: se traducen por índice contra los bloques que le dimos.
      const dados = blocks ?? [];
      return highlightIds
        .map((id) => dados.findIndex((b) => b.id === id))
        .filter((i) => i >= 0 && i < suyos.length)
        .map((i) => suyos[i].id)
        .filter((id): id is string => !!id);
    };

    // Esperar a que el panel TERMINE de abrirse. Se abre con animación, y medir a
    // mitad da un contenedor que todavía cambia de tamaño: el scroll se calcula contra
    // una altura que no es la final y aterriza en cualquier lado. Y como el bloque
    // marcado suele estar lejos (índice 75 de 102), sin scroll el amarillo se pinta
    // FUERA DE PANTALLA — se aplica y no se ve. Un solo fallo explicaba los dos
    // síntomas.
    //
    // No se espera un plazo fijo (la animación dura lo que dura): se espera a que la
    // altura del contenedor se repita en dos frames seguidos.
    let alturaPrevia = -1;
    let estables = 0;
    // "Asentado" = el nodo SE VE y su caja dejó de moverse.
    //
    // Lo de "se ve" no es paranoia: la traza mostró `visible:false, enPantalla:false`
    // con la clase ya puesta. React no desmonta un árbol que vuelve a suspender — lo
    // OCULTA con `display:none` —, y DocEditor se carga lazy, así que el efecto corría
    // sobre un árbol todavía oculto. Se marcaba y se scrolleaba algo que nadie veía,
    // que desde fuera es idéntico a no hacer nada.
    //
    // Se comprueba el NODO, no el contenedor: es la única condición que no depende de
    // saber QUÉ ancestro lo esconde ni de cómo esté implementada la apertura del panel.
    const asentado = (nodo: HTMLElement | null): boolean => {
      if (!nodo || nodo.offsetParent === null) {
        estables = 0;
        return false;
      }
      const r = nodo.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        estables = 0;
        return false;
      }
      const h = (contenedorQueScrollea(nodo) ?? scroller.current)?.clientHeight ?? 0;
      if (h > 0 && h === alturaPrevia) estables++;
      else estables = 0;
      alturaPrevia = h;
      return estables >= 2;
    };

    let intentos = 0;
    let t: ReturnType<typeof setTimeout>;
    const probar = () => {
      const ids = resolverIds();
      const primero = ids.length
        ? scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(ids[0])}"]`) ?? null
        : null;
      const nodo = primero?.querySelector<HTMLElement>(".bn-block-content") ?? primero;
      if (!asentado(nodo)) {
        // Ventana larga (~6s): entre que el panel abre, BlockNote pinta 102 bloques y
        // React descubre el árbol suspendido, puede pasar bastante rato.
        if (++intentos < 120) t = setTimeout(probar, 50);
        else console.warn("[doc] el bloque nunca se hizo visible", { ids, nodo: !!nodo });
        return;
      }
      if (intentos === 0)
        console.log("[doc:marca] resueltos", {
          ids,
          docLen: ((editor.document ?? []) as DocBlock[]).length,
          primeros: ((editor.document ?? []) as DocBlock[]).slice(0, 3).map((b) => b.id),
          enDom: ids.map((i) => !!scroller.current?.querySelector(`[data-id="${CSS.escape(i)}"]`)),
        });
      if (ids.length && marcarCambios(ids)) {
        yaSenalado.add(clave); // sólo cuando de verdad se pintó
        return;
      }
      if (++intentos < 20) {
        t = setTimeout(probar, 100); // hasta ~2s: BlockNote pinta cuando puede
      } else {
        // Que no se vaya en silencio otra vez: si no se pudo señalar, que quede dicho.
        console.warn("[doc] no pude señalar el cambio", { highlightIds, resueltos: ids });
      }
    };
    t = setTimeout(probar, 60);
    return () => clearTimeout(t);
  }, [editor, highlightIds, marcarCambios, blocks]);

  const notify = useCallback(() => {
    if (applying.current || !onChange) return;
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

      {/* Ir al final. Sólo cuando NO estás abajo — si no, es un botón que no hace nada
          tapando el documento. Mientras el agente escribe además avisa de que sigue
          llegando texto más abajo. */}
      {!alFondo ? (
        <button
          type="button"
          onClick={irAlFondo}
          aria-label={t("Ir al final")}
          title={t("Ir al final")}
          className="absolute bottom-5 right-5 z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-2 text-xs font-medium text-ink shadow-lg backdrop-blur transition hover:border-brand hover:text-brand"
        >
          <ArrowDown size={14} />
          {streaming ? t("Sigue escribiendo") : t("Ir al final")}
        </button>
      ) : null}
    </div>
  );
}
