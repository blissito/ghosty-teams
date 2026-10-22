// Elegir la cuenta de Google Ads después de conectar (cuando el Google tiene varias).
// Un toque en la tarjeta la elige: sin select ni botón «Usar esta cuenta». La tarjeta elegida se
// queda girando hasta que el padre recarga y este componente se desmonta (ya con la lista de
// campañas): así no hay un hueco vacío entre «elegida» y «campañas».
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../i18n";
import { adsGoogleAccountsFn, adsGoogleSelectFn, type GoogleAccount } from "../server/apps/ads";

const pretty = (id: string) => id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");

export function GoogleAccountPicker({ email, onPicked }: { email?: string | null; onPicked: () => unknown }) {
  const t = useT();
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adsGoogleAccountsFn()
      .then(setAccounts)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const pick = async (customerId: string) => {
    setPicking(customerId);
    setError(null);
    try {
      await adsGoogleSelectFn({ data: { customerId } });
      await onPicked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPicking(null);
    }
  };
  return (
    <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3">
      <p className="text-sm font-semibold text-ink">{t("¿Qué cuenta quieres ver aquí?")}</p>
      <p className="text-[11px] text-muted">
        {email ? `${email} · ` : ""}
        {t("tiene varias cuentas de Google Ads.")}
      </p>
      {accounts === null && !error && (
        <div className="mt-2 grid gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-3 motion-reduce:animate-none" />
          ))}
        </div>
      )}
      {accounts?.length === 0 && <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-400">{t("Ese Google no tiene cuentas de Google Ads. Reconecta con otra cuenta de Google.")}</p>}
      {!!accounts?.length && (
        <ul className="mt-2 grid gap-2">
          {accounts.map((a) => {
            const busy = picking === a.customerId;
            // Sin nombre en Google Ads, gs manda el mismo ID con guiones: no se repite.
            const named = !!a.name && a.name.replace(/\D/g, "") !== a.customerId.replace(/\D/g, "");
            return (
              <li key={a.customerId}>
                <button
                  type="button"
                  disabled={a.taken || !!picking}
                  onClick={() => void pick(a.customerId)}
                  className={`flex w-full items-center gap-3 rounded-lg border bg-surface px-3 py-2.5 text-left transition-colors disabled:cursor-default ${
                    busy ? "border-brand" : "border-border hover:border-brand"
                  } ${picking && !busy ? "opacity-40" : ""} ${a.taken ? "opacity-50" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{named ? a.name : pretty(a.customerId)}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {named ? `${pretty(a.customerId)} · ` : ""}
                      {a.currency ?? ""}
                      {named ? "" : ` · ${t("sin nombre en Google Ads")}`}
                      {a.taken ? ` · ${t("en otro espacio")}` : ""}
                    </span>
                  </span>
                  {busy && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-brand">
                      <Loader2 className="size-3.5 animate-spin" /> {t("Trayendo campañas…")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
