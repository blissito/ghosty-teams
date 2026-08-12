import { useState, type ReactNode } from "react";
import { Hash, Lock, Radio, Search, Settings, Star, AtSign, Clock, FileText } from "lucide-react";
import { Avatar } from "./Avatar";
import { SHOWCASE_ARTIFACTS, SHOWCASE_DMS, SHOWCASE_ROOMS } from "../lib/showcase-data";

// El chrome de Ghosty Teams alrededor de la sala de un evento.
//
// ⚠️ Es una RÉPLICA VISUAL, no el shell de verdad. `c.$slug.tsx` son ~10,700 líneas con
// dieciocho superficies que sirven datos del workspace —lista de rooms con nombres y
// descripciones, hilos precargados, buscador, command palette, typeahead de menciones con
// el directorio entero, presencia con nombres, DMs, miembros, documentos, repos y PRs,
// ajustes, facturación, switcher de workspaces y el panel de turnos vivos, donde `tarea` es
// el texto literal que escribió una persona—. Meter ahí a un desconocido exige auditar las
// dieciocho Y que ninguna se reabra en el próximo cambio; basta un hueco para enseñarle
// datos de un cliente a 100 personas.
//
// Como todo lo de alrededor es de mentira (ver `lib/showcase-data.ts`), el invitado no
// necesita tocar el shell real: lo que se enseña es la FORMA del producto.
//
// ⚠️ Riesgo asumido: esto se despega del original cuando el shell cambie. Se acota reusando
// los componentes ya extraídos (`Avatar`) y aceptando que es una maqueta con fecha de
// caducidad — para un evento, está bien.

const CTA = "https://ghosty.studio/planes";

/**
 * Envuelve lo que está de adorno. UN componente y no un `disabled` por elemento: así el
 * aviso y la liga se escriben una vez, y nada se queda sin cubrir por olvido — que es
 * exactamente cómo un escaparate acaba teniendo un botón que sí hace algo.
 */
function Inert({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [avisa, setAvisa] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setAvisa((v) => !v)}
        onBlur={() => setAvisa(false)}
        className="w-full cursor-default text-left opacity-60 transition-opacity hover:opacity-90"
      >
        {children}
      </button>
      {avisa && (
        <div className="absolute left-2 right-2 top-full z-20 mt-1 rounded-lg border border-border bg-card p-2 text-[11px] shadow-lg">
          <p className="mb-1 text-muted">Esto es de los miembros del espacio.</p>
          <a href={CTA} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
            Prueba Ghosty Teams →
          </a>
        </div>
      )}
    </div>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}

export function EventSidebar({ eventName, online }: { eventName: string; online: number }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface-2 p-2 text-sm">
      <Inert className="mb-3">
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-xs font-bold text-white">
            G
          </div>
          <span className="truncate font-semibold">Mi espacio</span>
        </div>
      </Inert>

      <Inert className="mb-3">
        <div className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-muted">
          <Search size={14} /> <span className="text-xs">Buscar…</span>
        </div>
      </Inert>

      <SidebarSection title="Vistas">
        {[
          { icon: Clock, label: "Recientes" },
          { icon: AtSign, label: "Menciones" },
          { icon: Star, label: "Destacados" },
        ].map(({ icon: Icon, label }) => (
          <Inert key={label}>
            <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-muted">
              <Icon size={14} /> {label}
            </div>
          </Inert>
        ))}
      </SidebarSection>

      <SidebarSection title="Rooms">
        {/* El ÚNICO vivo, y va primero: es donde está la persona. Marcarlo como los demás
            haría que se perdiera entre el decorado. */}
        <div className="mb-0.5 flex items-center gap-2 rounded-lg bg-brand/15 px-2 py-1 font-semibold text-brand">
          <Radio size={14} className="shrink-0" />
          <span className="truncate">{eventName}</span>
          <span className="ml-auto shrink-0 rounded bg-emerald-500/20 px-1 py-px text-[9px] font-bold uppercase text-emerald-600">
            en vivo
          </span>
        </div>
        {SHOWCASE_ROOMS.map((r) => (
          <Inert key={r.name}>
            <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-muted">
              <Hash size={14} className="shrink-0" />
              <span className="truncate">{r.name}</span>
              {r.unread ? (
                <span className="ml-auto shrink-0 rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">
                  {r.unread}
                </span>
              ) : null}
            </div>
          </Inert>
        ))}
      </SidebarSection>

      <SidebarSection title="Mensajes directos">
        {SHOWCASE_DMS.map((d) => (
          <Inert key={d.name}>
            <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-muted">
              <span className="relative shrink-0">
                <Avatar name={d.name} className="size-5" />
                {d.online && (
                  <span className="absolute -bottom-px -right-px size-2 rounded-full border border-surface-2 bg-emerald-500" />
                )}
              </span>
              <span className="truncate">{d.name}</span>
            </div>
          </Inert>
        ))}
      </SidebarSection>

      <div className="mt-auto pt-2">
        <div className="mb-2 rounded-lg border border-border bg-card p-2.5">
          <p className="mb-1 text-[11px] leading-snug text-muted">
            Estás en el room del evento con <strong className="text-ink">{online}</strong>{" "}
            {online === 1 ? "persona" : "personas"}.
          </p>
          <a href={CTA} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-brand hover:underline">
            Crea tu propio espacio →
          </a>
        </div>
        <Inert>
          <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-muted">
            <Settings size={14} /> Ajustes
          </div>
        </Inert>
      </div>
    </div>
  );
}

/** Panel derecho: que se vea que el agente PRODUCE cosas, no sólo que conversa. */
export function EventArtifacts() {
  return (
    <div className="flex h-full flex-col overflow-y-auto border-l border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted">
        <FileText size={12} /> Documentos del espacio
      </div>
      {SHOWCASE_ARTIFACTS.map((a) => (
        <Inert key={a.title} className="mb-1.5">
          <div className="rounded-lg border border-border bg-card p-2.5">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="rounded bg-brand/15 px-1 py-px text-[9px] font-bold uppercase text-brand">{a.kind}</span>
              <Lock size={10} className="text-muted" />
            </div>
            <div className="truncate text-xs font-medium">{a.title}</div>
            <div className="text-[10px] text-muted">{a.when}</div>
          </div>
        </Inert>
      ))}
    </div>
  );
}
