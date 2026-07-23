import { useEffect, useRef, useState } from "react";
import { fleetChannelStateFn, setFleetChannelFn } from "../server/agent-config";
import { FleetCapabilities } from "./FleetCapabilities";
import { useT } from "../i18n";

const STUDIO = "https://www.ghosty.studio";

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-brand" : "bg-surface-3"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

/**
 * Controles del agente de flota en Ajustes. En tenant NATIVO: sólo encender/apagar
 * (la config —identidad/modelo— vive en Ghosty Studio). En tenant EasyBits: cae al
 * editor completo de siempre (FleetCapabilities). Más adelante metemos más aquí.
 */
export function FleetAgentControls({ agentId }: { agentId: number }) {
  const t = useT();
  const [state, setState] = useState<
    | { loading: true }
    | { loading: false; native: false }
    | { loading: false; native: true; teams: boolean; name?: string; fleetId: string }
  >({ loading: true });
  const [busy, setBusy] = useState(false);
  const cur = useRef(false);

  useEffect(() => {
    let alive = true;
    fleetChannelStateFn({ data: { id: agentId } })
      .then((r) => {
        if (!alive) return;
        if (r.native) {
          cur.current = r.teams ?? true;
          setState({ loading: false, native: true, teams: r.teams ?? true, name: r.name, fleetId: r.fleetId });
        } else {
          setState({ loading: false, native: false });
        }
      })
      .catch(() => alive && setState({ loading: false, native: false }));
    return () => { alive = false; };
  }, [agentId]);

  if (state.loading) {
    return <div className="h-24 animate-pulse rounded-lg bg-surface-2" />;
  }
  // No nativo → editor completo de siempre.
  if (!state.native) {
    return <FleetCapabilities agentId={agentId} />;
  }

  const toggle = async (v: boolean) => {
    setBusy(true);
    setState((s) => (s.loading === false && s.native ? { ...s, teams: v } : s)); // optimista
    try {
      await setFleetChannelFn({ data: { id: agentId, on: v } });
      cur.current = v;
    } catch {
      setState((s) => (s.loading === false && s.native ? { ...s, teams: cur.current } : s)); // revertir
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{state.teams ? t("Agente encendido") : t("Agente apagado")}</div>
          <div className="mt-0.5 text-xs text-muted">
            {state.teams ? t("Responde en este espacio.") : t("No responde hasta que lo enciendas.")}
          </div>
        </div>
        <Switch on={state.teams} onChange={toggle} disabled={busy} />
      </div>

      <a
        href={`${STUDIO}/app/fleet/${state.fleetId}`}
        target="_blank"
        rel="noreferrer"
        className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted transition-colors hover:border-brand hover:text-ink"
      >
        {t("Configura la identidad, el modelo y más en Ghosty Studio")} ↗
      </a>
    </div>
  );
}
