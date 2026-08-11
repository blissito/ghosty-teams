import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { createServerFn } from "@tanstack/react-start";
import GhostyMascot from "../components/GhostyMascot";

// Puerta PÚBLICA de un evento: /en-vivo/<slug>.
//
// Aquí entra la comunidad —gente que no es del workspace y que no debe ocupar
// asiento—, deja su nombre y su correo, y sale rumbo a la sala con un ticket
// firmado que lleva su rol dentro.
//
// Esta página es la frontera. Todo lo que decide quién puede hablar se resuelve
// del lado servidor y viaja firmado; el navegador no aporta más que el nombre y
// el correo, que son datos, no permisos. En un webinar el rol es justo lo que
// alguien querría cambiarse, así que no puede salir de la URL.
//
// No toca `auth.ts` ni crea `Membership`: un asistente no es un miembro del
// workspace y no consume asiento. Ver "salas de evento" en schema.server.ts.

type EventInfo = {
  title: string;
  roomName: string;
  mode: "webinar" | "taller";
  live: boolean;
};

const loadEvent = createServerFn({ method: "GET" })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<EventInfo | null> => {
    await (await import("../server/schema.server")).ensureSchema().catch(() => {});
    const { channelByShareSlug } = await import("../db.server");
    const ch = await channelByShareSlug(data.slug);
    if (!ch || !ch.call_mode) return null;
    return {
      title: ch.call_title || ch.name,
      roomName: ch.name,
      mode: ch.call_mode,
      live: false,
    };
  });

const joinEvent = createServerFn({ method: "POST" })
  .validator((d: { slug: string; name: string; email: string }) => d)
  .handler(async ({ data }): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    await (await import("../server/schema.server")).ensureSchema().catch(() => {});

    const name = (data.name ?? "").trim().slice(0, 60);
    const email = (data.email ?? "").trim().toLowerCase().slice(0, 120);
    if (name.length < 2) return { ok: false, error: "Escribe tu nombre" };
    // Validación deliberadamente floja: sirve para atajar erratas, no para
    // verificar que el correo existe. Rechazar de más deja gente fuera de un
    // evento en vivo, que es peor que un correo inválido en la lista.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Escribe un correo válido" };

    const db = await import("../db.server");
    const ch = await db.channelByShareSlug(data.slug);
    // "No existe" y "ya no está abierto" responden igual: el error no debe
    // confirmar qué slugs son reales para quien esté probando.
    if (!ch || !ch.call_mode) return { ok: false, error: "Este evento no está disponible" };

    // Límite por IP, en la DB (un contador en memoria no sobrevive un deploy ni
    // sirve con dos procesos). Sin IP no hay bypass: su propia cubeta, más
    // estrecha. Reusa el limitador de formularios, que ya resuelve justo esto.
    const { rateCheck, clientIp } = await import("../server/forms/rate.server");
    const ip = clientIp(getRequest());
    const { ipHash, allowed } = await rateCheck(`evt:${ch.id}`, ip, {
      scope: "envivo",
      windowS: 60,
      maxWithIp: 8,
      maxNoIp: 4,
    });
    if (!allowed) return { ok: false, error: "Demasiados intentos. Espera un minuto." };

    // Identidad estable del invitado: el `sub` lo acuña el SERVIDOR y vive en
    // cookie, así que nadie puede presentarse con el `sub` de un miembro.
    const { guestSubForEvents } = await import("../server/events/guest.server");
    const guestSub = await guestSubForEvents();

    const { banned } = await db.registerForEvent({ channelId: ch.id, name, email, guestSub, ipHash });
    // Mismo texto que un evento cerrado: decirle "estás vetado" sólo le enseña a
    // volver con otro correo.
    if (banned) return { ok: false, error: "Este evento no está disponible" };

    const base = ch.call_livekit_url || process.env.EVENT_LIVEKIT_URL || "";
    if (!base) return { ok: false, error: "La sala no está configurada" };

    const { currentNamespace } = await import("../server/tenant.server");
    const { eventRoomName, mintEventTicket, eventRoomUrl } = await import("../server/events/ticket.server");
    const ns = await currentNamespace();
    const room = eventRoomName(ns, ch.id);
    // El rol lo dicta el MODO del room, nunca el cliente: en un webinar se entra
    // a escuchar y el host reparte la palabra desde su panel.
    const role = ch.call_mode === "webinar" ? "viewer" : "speaker";

    let ticket: string;
    try {
      ticket = mintEventTicket({ room, name, role, mode: ch.call_mode, title: ch.call_title || ch.name });
    } catch (e) {
      console.error("[en-vivo] no pude firmar el ticket", e);
      return { ok: false, error: "La sala no está configurada" };
    }
    return { ok: true, url: eventRoomUrl(base, room, ticket) };
  });

export const Route = createFileRoute("/en-vivo/$slug")({
  loader: async ({ params }) => {
    const info = await loadEvent({ data: { slug: params.slug } });
    if (!info) throw notFound();
    return info;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} — en vivo` : "En vivo" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: EnVivo,
});

function EnVivo() {
  const info = Route.useLoaderData();
  const { slug } = Route.useParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await joinEvent({ data: { slug, name, email } });
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return;
      }
      // Reemplaza la entrada del historial: si la persona le da "atrás" desde la
      // sala, no debe caer en un formulario que ya envió y volver a registrarse.
      window.location.replace(r.url);
    } catch {
      setError("No pude conectarte. Intenta de nuevo.");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--color-bg)] p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-7 shadow-sm">
        <div className="flex items-center gap-2 mb-5">
          <GhostyMascot className="h-7 w-7" />
          <span className="font-semibold tracking-tight">Ghosty</span>
        </div>

        <h1 className="text-xl font-semibold leading-snug">{info.title}</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          {info.mode === "webinar"
            ? "Entras a escuchar. Si quieres participar, quien modera puede darte la palabra."
            : "Sesión de trabajo: entras con micrófono y cámara."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1" htmlFor="ev-name">Tu nombre</label>
            <input
              id="ev-name" value={name} onChange={(e) => setName(e.target.value)}
              autoComplete="name" required maxLength={60}
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-base"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" htmlFor="ev-email">Tu correo</label>
            <input
              id="ev-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" required maxLength={120}
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-base"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit" disabled={busy}
            className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-medium text-white disabled:opacity-60"
          >
            {busy ? "Conectando…" : "Entrar a la sala"}
          </button>
        </form>

        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Usamos tu correo para darte acceso y avisarte de la grabación. Nada más.
        </p>
      </div>
    </div>
  );
}
