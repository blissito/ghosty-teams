import { useEffect, useState } from "react";
import { nativeAgentConfigFn, setNativeAgentConfigFn, type NativeAgentConfig as Cfg } from "../server/agent-config";
import { useT } from "../i18n";

/**
 * Config del agente que corre en el native gs runtime, desde Ajustes de Teams:
 * MODELO y PROMPT BASE. Studio sigue siendo la fuente única — esto sólo llama a sus
 * capabilities por HMAC de partner.
 *
 * Lo que NO está aquí, a propósito: "razonamiento" (no existe en el runtime nativo;
 * era un concepto de EasyBits y el select salía vacío), el MOTOR (cambiarlo es otra
 * clase de caja) y la búsqueda web nativa (perilla de admin, vive en Studio).
 */
export function NativeAgentConfig({ agentId }: { agentId: number }) {
  const t = useT();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    nativeAgentConfigFn({ data: { id: agentId } })
      .then((r) => {
        if (!alive || !r.native) return;
        setCfg(r);
        setPrompt(r.prompt ?? "");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (!cfg) {
    return <div className="h-40 animate-pulse rounded-xl bg-surface-2" />;
  }

  const aplicar = async (body: Record<string, unknown>, optimista: () => void, revertir: () => void) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    optimista();
    try {
      await setNativeAgentConfigFn({ data: { id: agentId, body } });
      setSaved(t("Guardado."));
    } catch (e) {
      revertir();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cambiarModelo = (model: string) => {
    const antes = cfg.model;
    aplicar(
      { action: "set-model", model },
      () => setCfg((c) => (c ? { ...c, model } : c)),
      () => setCfg((c) => (c ? { ...c, model: antes } : c)),
    );
  };

  const guardarPrompt = () => {
    const antes = cfg.prompt;
    aplicar(
      { action: "set-prompt", prompt },
      () => setCfg((c) => (c ? { ...c, prompt } : c)),
      () => setCfg((c) => (c ? { ...c, prompt: antes } : c)),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("Modelo")}
        </label>
        <select
          value={cfg.model ?? ""}
          disabled={busy}
          onChange={(e) => cambiarModelo(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
        >
          {cfg.models.map((m) => (
            <option key={m.id} value={m.id} disabled={m.ready === false}>
              {m.label}
              {m.ready === false ? ` ${t("(próximamente)")}` : ""}
            </option>
          ))}
        </select>
        {/* Se dice porque es real y se nota: cambiar de modelo recicla la caja del
            agente, y con ella el hilo de la conversación en curso. */}
        <p className="mt-1 text-xs text-muted">
          {t("Motor")}: {cfg.engineLabel}. {t("Al cambiar de modelo, la conversación arranca de nuevo.")}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          {t("Prompt base (todos los canales)")}
        </label>
        <textarea
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          placeholder={t("Instrucciones base del agente (rol, tono, reglas)…")}
          className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {t("Es la identidad del agente en todos los espacios. Se aplica al siguiente turno.")}
          </p>
          <button
            type="button"
            disabled={busy || prompt === (cfg.prompt ?? "")}
            onClick={guardarPrompt}
            className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {t("Guardar")}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {error}
        </p>
      )}
      {saved && !error && <p className="text-xs text-muted">{saved}</p>}
    </div>
  );
}
