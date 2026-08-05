import { createFileRoute } from "@tanstack/react-router";
import { BrandPanel } from "../components/BrandPanel";

// Banco del panel de Marca — SÓLO en desarrollo (el guard de __root lo exime ahí y nada
// más). Reproduce la caja real del modal de Ajustes: alto fijo, rail a la izquierda y el
// cuerpo scrolleando por dentro. Es la única forma de ajustar este layout sin entrar a
// una sesión, y sin ajustarlo a base de deploys.
//
// Mismo espíritu que /doc-probe y /canvas-probe.

export const Route = createFileRoute("/brand-probe")({
  component: BrandProbe,
});

function BrandProbe() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-surface-3 p-6">
      {/* Las MISMAS medidas que SettingsContent: h-[85dvh] max-h-[620px]. Si el panel
          cabe aquí, cabe en el modal. */}
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <div className="flex h-[85dvh] max-h-[620px] text-ink">
          <div className="w-48 shrink-0 border-r border-border bg-surface-2 p-3 text-xs text-muted">
            <p className="px-2 py-1.5 font-semibold text-ink">Preferencias</p>
            <p className="mt-2 rounded-lg bg-brand/10 px-2 py-1.5 font-semibold text-brand">Marca</p>
            <p className="mt-3 px-2 text-[10px] leading-relaxed">
              banco de pruebas · sólo dev
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <BrandPanel isOwner />
          </div>
        </div>
      </div>
    </div>
  );
}
