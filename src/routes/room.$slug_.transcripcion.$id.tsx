import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { colorDeNombre } from "../components/chat/message";

// ── La transcripción de una grabación, LEGIBLE ──────────────────────────────
//
// ⚠️ Existe porque la primera versión "entregaba" el transcript abriendo el `.txt` crudo
// de storage en una pestaña. Eso son 9.000 palabras sin puntuación, a un solo bloque, con
// los acentos rotos —el navegador adivina latin-1 cuando el objeto no declara charset— y
// sin forma de buscar ni de saltar a un momento. Un enlace a un archivo no es una entrega.
//
// Aquí el texto se sirve desde NUESTRO servidor (así el charset es nuestro y no una
// suposición del navegador), partido por marcas de tiempo y con buscador.

type Segmento = { t: string; segundos: number; texto: string; quien: string | null };

/**
 * Parte la salida de whisper en segmentos.
 *
 * Hay TRES formas por ahí fuera y las tres tienen que leerse:
 *
 *   `[00:01:02.500 --> 00:01:07.000] fresnnyy: texto`  ← con hablante (lo de hoy)
 *   `[00:01:02.500 --> 00:01:07.000]  texto`           ← sólo marca
 *   `texto corrido sin nada`                           ← anteriores al 2026-08-12
 *
 * La última se corta cada ~350 caracteres para que al menos haya párrafos.
 *
 * ⚠️ El nombre se acepta sin espacios (`fresnnyy:`) a propósito: una frase que empiece por
 * "bueno: mira" no puede confundirse con un hablante.
 */
export function partirTranscripcion(texto: string): Segmento[] {
  const conMarca = [...texto.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\.\d+\s*-->[^\]]+\]\s*(.*)/g)];
  if (conMarca.length) {
    return conMarca
      .map((m) => {
        const resto = m[4].trim();
        const conQuien = /^(\S[^:\s]{0,58}):\s+(.*)$/.exec(resto);
        return {
          t: m[1] === "00" ? `${m[2]}:${m[3]}` : `${m[1]}:${m[2]}:${m[3]}`,
          segundos: +m[1] * 3600 + +m[2] * 60 + +m[3],
          quien: conQuien ? conQuien[1] : null,
          texto: conQuien ? conQuien[2] : resto,
        };
      })
      .filter((s) => s.texto);
  }
  const limpio = texto.replace(/\s+/g, " ").trim();
  const trozos: Segmento[] = [];
  for (let i = 0; i < limpio.length; i += 350) {
    // Se corta en el siguiente espacio para no partir una palabra por la mitad.
    const fin = limpio.indexOf(" ", i + 350);
    trozos.push({ t: "", segundos: 0, quien: null, texto: limpio.slice(i, fin === -1 ? undefined : fin) });
    if (fin === -1) break;
    i = fin - 350;
  }
  return trozos;
}

const cargar = createServerFn({ method: "GET" })
  .validator((d: { slug: string; id: number }) => d)
  .handler(async ({ data }) => {
    const { channelByShareSlug } = await import("../db.server");
    const ch = await channelByShareSlug(data.slug);
    if (!ch) return null;
    // El mismo criterio que el room: si puedes ver la sala, puedes leer su transcripción.
    const { eventViewerFor } = await import("../server/events/access.server");
    const viewer = await eventViewerFor(ch).catch(() => null);
    if (!viewer) return null;

    const { dbq } = await import("../dbq.server");
    const filas = await dbq(
      "SELECT transcript_key, started_at, ended_at FROM gt_event_recordings WHERE id = ? AND channel_id = ?",
      [data.id, ch.id]
    );
    const fila = filas[0];
    if (!fila?.transcript_key) return null;

    const { signedUrl } = await import("../server/storage.server");
    // ⚠️ El texto se descarga AQUÍ y se sirve desde nuestro dominio. Redirigir a la URL
    // firmada era justo el problema: el objeto no declara charset y el navegador lo lee
    // como latin-1, así que "cómo" se ve "cÃ³mo" en toda la página.
    const r = await fetch(signedUrl(String(fila.transcript_key), 600), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    return {
      texto: await r.text(),
      titulo: ch.call_title || ch.name,
      endedAt: Number(fila.ended_at),
      minutos: fila.started_at ? Math.max(1, Math.round((Number(fila.ended_at) - Number(fila.started_at)) / 60)) : null,
    };
  });

// ⚠️ El archivo se llama `room.$slug_.transcripcion.$id` con GUION BAJO. Sin él, TanStack
// anida esta ruta bajo `room.$slug`, que no es un layout y no pinta ningún <Outlet/>: el
// resultado es que al abrir la transcripción se vuelve a pintar la sala, como si el enlace
// no hiciera nada. La URL pública no cambia.
/**
 * Junta los segmentos consecutivos del mismo hablante. Repetir el nombre en cada línea de
 * una frase partida en cinco trozos es ruido, no información.
 */
/**
 * Parte el texto por el término buscado para poder marcarlo. Sin esto, un párrafo entero
 * en amarillo no dice DÓNDE está la palabra, que es justo lo que se estaba buscando.
 */
function resaltar(texto: string, q: string) {
  const t = q.trim();
  if (!t) return texto;
  // La búsqueda es literal, así que los caracteres especiales se escapan: buscar "¿qué?"
  // con una regex sin escapar no encuentra nada o revienta.
  const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return texto.split(re).map((trozo, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-brand/30 px-0.5 text-ink">{trozo}</mark>
    ) : (
      trozo
    )
  );
}

export function agruparPorHablante(segs: Segmento[]): { quien: string | null; t: string; texto: string }[] {
  const out: { quien: string | null; t: string; texto: string }[] = [];
  for (const s of segs) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.quien === s.quien && s.quien !== null) {
      ultimo.texto += " " + s.texto;
    } else {
      out.push({ quien: s.quien, t: s.t, texto: s.texto });
    }
  }
  return out;
}

export const Route = createFileRoute("/room/$slug_/transcripcion/$id")({
  loader: async ({ params }) => {
    const d = await cargar({ data: { slug: params.slug, id: Number(params.id) } });
    if (!d) throw notFound();
    return d;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `Transcripción · ${loaderData.titulo}` : "Transcripción" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Transcripcion,
});

function Transcripcion() {
  const data = Route.useLoaderData();
  const { slug } = Route.useParams();
  const [q, setQ] = useState("");
  // Índice de la coincidencia actual. Buscar en 74 minutos sin poder saltar de una a otra
  // es encontrar la palabra y seguir sin saber dónde está.
  const [idx, setIdx] = useState(0);
  const [abajo, setAbajo] = useState(false);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const segmentos = useMemo(() => partirTranscripcion(data.texto), [data.texto]);
  // ⚠️ Buscar NO filtra. Filtrar dejaba tres párrafos sueltos en pantalla —todos visibles
  // a la vez, así que saltar entre ellos no servía de nada— y sobre todo mataba el
  // contexto: en una transcripción, una frase sin lo que se dijo antes no dice nada.
  // Se pinta todo y se marcan las coincidencias.
  const bloques = useMemo(() => agruparPorHablante(segmentos), [segmentos]);
  const coincidencias = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return bloques
      .map((b, i) => (b.texto.toLowerCase().includes(t) || (b.quien ?? "").toLowerCase().includes(t) ? i : -1))
      .filter((i) => i >= 0);
  }, [bloques, q]);
  // Se dice si la transcripción trae hablantes o no: en una que no los tiene, no
  // encontrarlos hace dudar de si el buscador funciona.
  const hayNombres = useMemo(() => segmentos.some((s) => s.quien), [segmentos]);

  // Al cambiar la búsqueda se vuelve a la primera: dejar el índice donde estaba haría
  // saltar a un sitio que ya no corresponde a lo que se buscó.
  useEffect(() => { setIdx(0); }, [q]);

  const irA = (n: number) => {
    if (!coincidencias.length) return;
    const destino = (n + coincidencias.length) % coincidencias.length; // circular
    setIdx(destino);
    refs.current[coincidencias[destino]]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // "¿Estoy abajo?" con holgura, igual que en el chat: pedir el píxel exacto haría que un
  // scroll suave sin terminar contara como "no he llegado".
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const alScroll = () => setAbajo(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    alScroll();
    el.addEventListener("scroll", alScroll, { passive: true });
    return () => el.removeEventListener("scroll", alScroll);
  }, []);

  return (
    /* ⚠️ Scroll PROPIO, no el de la página. `body { overflow-x: hidden }` (styles.css,
       puesto para que nada haga la app pannable en móvil) convierte al body en el
       contenedor de scroll, y dentro de él `position: sticky` deja de pegarse al viewport:
       la barra de búsqueda se iba con el texto. Ese CSS es load-bearing, así que la que se
       adapta es esta página. */
    <div ref={scrollerRef} className="h-dvh overflow-y-auto bg-surface text-ink">
      <div className="mx-auto max-w-3xl px-5 py-8">
        <Link to="/room/$slug" params={{ slug }} className="text-xs text-muted hover:text-ink">
          ← Volver a la sala
        </Link>
        <h1 className="mt-3 text-2xl font-bold leading-tight">{data.titulo}</h1>
        <p className="mt-1 text-sm text-muted">
          Transcripción ·{" "}
          {new Date(data.endedAt * 1000).toLocaleString([], {
            day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
          })}
          {data.minutos ? ` · ${data.minutos} min` : ""}
        </p>
        <p className="mt-1 text-xs text-muted">
          Generada automáticamente: puede tener errores, sobre todo en nombres y cifras.
          {!hayNombres && " Esta grabación es anterior a que se anotara quién habla."}
        </p>

        {/* ⚠️ PEGAJOSA. Con la búsqueda fija arriba del documento, saltar a una
            coincidencia te dejaba sin los botones para ir a la siguiente: había que subir
            74 minutos de scroll para volver a pulsarlos. Viajando contigo, ‹ n/m › está
            siempre donde la mano. */}
        <div className="sticky top-0 z-10 -mx-1 bg-surface/95 px-1 pb-3 pt-4 backdrop-blur">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar en la transcripción…"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {q && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              {coincidencias.length === 0 ? (
                <span>Sin coincidencias</span>
              ) : (
                <>
                  <span>
                    {idx + 1} de {coincidencias.length}
                  </span>
                  <button
                    onClick={() => irA(idx - 1)}
                    aria-label="Coincidencia anterior"
                    className="rounded p-1 hover:bg-surface-2 hover:text-ink"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={() => irA(idx + 1)}
                    aria-label="Siguiente coincidencia"
                    className="rounded p-1 hover:bg-surface-2 hover:text-ink"
                  >
                    <ChevronDown size={14} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="mt-6 space-y-4">
          {bloques.map((s, i) => (
            <div
              key={i}
              ref={(el) => { refs.current[i] = el; }}
              className={`flex gap-3 rounded-lg text-[15px] leading-relaxed transition-colors ${
                q && coincidencias[idx] === i ? "bg-brand/10" : ""
              }`}
            >
              {/* La marca de tiempo a la izquierda, en su columna: es lo que convierte un
                  muro en algo por donde se puede navegar. Las grabaciones viejas no la
                  tienen y entonces no se pinta nada — mejor que un 00:00 falso. */}
              {s.t && (
                <span className="shrink-0 select-none pt-1 font-mono text-xs text-muted">{s.t}</span>
              )}
              <div>
                {/* El mismo color que en el chat: quien habla se reconoce sin leer. */}
                {s.quien && (
                  <span className="mr-2 font-semibold" style={{ color: colorDeNombre(s.quien) }}>
                    {s.quien}
                  </span>
                )}
                <span>{resaltar(s.texto, q)}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-10 border-t border-border pt-4 text-xs text-muted">
          Transcrita en la propia sala, sin enviar el audio a ningún servicio externo.
        </p>
      </div>

      {/* Un solo botón que cambia de sentido. Dos botones fijos —bajar y subir— obligan a
          mirar cuál toca; éste dice siempre lo único que se puede hacer desde donde estás. */}
      <button
        onClick={() =>
          scrollerRef.current?.scrollTo({
            top: abajo ? 0 : scrollerRef.current.scrollHeight,
            behavior: "smooth",
          })
        }
        aria-label={abajo ? "Volver arriba" : "Ir al final"}
        title={abajo ? "Volver arriba" : "Ir al final"}
        className="fixed bottom-6 right-6 grid size-10 place-items-center rounded-full bg-brand text-white shadow-lg hover:opacity-90"
      >
        {abajo ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
    </div>
  );
}
