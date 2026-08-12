import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

// ── La transcripción de una grabación, LEGIBLE ──────────────────────────────
//
// ⚠️ Existe porque la primera versión "entregaba" el transcript abriendo el `.txt` crudo
// de storage en una pestaña. Eso son 9.000 palabras sin puntuación, a un solo bloque, con
// los acentos rotos —el navegador adivina latin-1 cuando el objeto no declara charset— y
// sin forma de buscar ni de saltar a un momento. Un enlace a un archivo no es una entrega.
//
// Aquí el texto se sirve desde NUESTRO servidor (así el charset es nuestro y no una
// suposición del navegador), partido por marcas de tiempo y con buscador.

type Segmento = { t: string; segundos: number; texto: string };

/**
 * Parte la salida de whisper en segmentos.
 *
 * Whisper emite `[00:01:02.500 --> 00:01:07.000]   texto`. Pero las grabaciones anteriores
 * al 2026-08-12 se generaron SIN marcas de tiempo, así que hay que sobrevivir a las dos
 * formas: sin marcas, se corta cada ~350 caracteres para que al menos haya párrafos.
 */
export function partirTranscripcion(texto: string): Segmento[] {
  const conMarca = [...texto.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\.\d+\s*-->[^\]]+\]\s*(.*)/g)];
  if (conMarca.length) {
    return conMarca
      .map((m) => ({
        t: m[1] === "00" ? `${m[2]}:${m[3]}` : `${m[1]}:${m[2]}:${m[3]}`,
        segundos: +m[1] * 3600 + +m[2] * 60 + +m[3],
        texto: m[4].trim(),
      }))
      .filter((s) => s.texto);
  }
  const limpio = texto.replace(/\s+/g, " ").trim();
  const trozos: Segmento[] = [];
  for (let i = 0; i < limpio.length; i += 350) {
    // Se corta en el siguiente espacio para no partir una palabra por la mitad.
    const fin = limpio.indexOf(" ", i + 350);
    trozos.push({ t: "", segundos: 0, texto: limpio.slice(i, fin === -1 ? undefined : fin) });
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
  const segmentos = useMemo(() => partirTranscripcion(data.texto), [data.texto]);
  const filtrados = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? segmentos.filter((s) => s.texto.toLowerCase().includes(t)) : segmentos;
  }, [segmentos, q]);

  return (
    <div className="min-h-dvh bg-surface text-ink">
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
        </p>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar en la transcripción…"
          className="mt-5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        {q && (
          <p className="mt-2 text-xs text-muted">
            {filtrados.length === 0
              ? "Sin coincidencias"
              : `${filtrados.length} de ${segmentos.length} fragmentos`}
          </p>
        )}

        <div className="mt-6 space-y-3">
          {filtrados.map((s, i) => (
            <p key={i} className="flex gap-3 text-[15px] leading-relaxed">
              {/* La marca de tiempo a la izquierda, en su columna: es lo que convierte un
                  muro en algo por donde se puede navegar. Las grabaciones viejas no la
                  tienen y entonces no se pinta nada — mejor que un 00:00 falso. */}
              {s.t && (
                <span className="shrink-0 select-none pt-0.5 font-mono text-xs text-muted">{s.t}</span>
              )}
              <span>{s.texto}</span>
            </p>
          ))}
        </div>

        <p className="mt-10 border-t border-border pt-4 text-xs text-muted">
          Transcrita en la propia sala, sin enviar el audio a ningún servicio externo.
        </p>
      </div>
    </div>
  );
}
