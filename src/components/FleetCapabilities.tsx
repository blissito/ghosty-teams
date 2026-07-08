import { useEffect, useState, useCallback } from "react";
import { Loader2, Plus, Trash2, Sparkles } from "lucide-react";
import { useT } from "../i18n";
import { agentFleetConfigFn, setAgentFleetConfigFn } from "../server/agent-config";

// Panel de capacidades de un fleet agent (modelo, razonamiento, herramientas,
// conectores, MCPs custom, skills, entregables). Lee/escribe en vivo contra la API
// capabilities de EasyBits vía el proxy server (fuente única = EasyBits). Todas las
// mutaciones por-canal usan groupId "*" = el default del agente (aplica a todo canal).
const GROUP = "*";

type Cap = {
  name: string;
  label: string;
  mode: string;
  requiredSecrets: string[];
  secretFields: Record<string, { label: string; help?: string }>;
  secretsPresent: boolean;
  levels: { key: string; label: string }[] | null;
  curated: boolean;
};
type Cfg = {
  fleet: boolean;
  builtins?: { name: string; label: string }[];
  capabilities?: Cap[];
  secretsPresent?: string[];
  groups?: Record<string, { mcpServers?: string[]; disabledBuiltins?: string[]; capLevels?: Record<string, string>; assets?: string[] }>;
  ownerFiles?: { id: string; name: string; contentType?: string }[];
  agent?: { systemPrompt: string; model: string; effort: string; hasOwnNumber: boolean; buckets: string[] };
  buckets?: { key: string; label: string; description: string; admin: boolean }[];
  models?: { key: string; label: string }[];
  efforts?: string[];
  skills?: { id: string; name: string; description: string; enabled: boolean; fileCount: number }[];
  customMcps?: { name: string; label: string; transport: string; requiredSecrets: string[] }[];
};

export function FleetCapabilities({ agentId }: { agentId: number }) {
  const t = useT();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // key de lo que se guarda
  const [q, setQ] = useState("");

  const load = useCallback(
    (query?: string) =>
      agentFleetConfigFn({ data: { id: agentId, q: query } })
        .then((c) => setCfg(c as Cfg))
        .catch((e) => setErr(e instanceof Error ? e.message : String(e))),
    [agentId]
  );
  useEffect(() => {
    load();
  }, [load]);

  // Aplica una mutación y recarga. `key` marca el control que muestra spinner.
  const mut = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setErr(null);
    try {
      await setAgentFleetConfigFn({ data: { id: agentId, body } });
      await load(q || undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (err && !cfg) return <p className="px-1 py-2 text-xs text-red-400">{err}</p>;
  if (!cfg) return <p className="flex items-center gap-2 px-1 py-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t("Cargando capacidades…")}</p>;

  const g = cfg.groups?.[GROUP] ?? {};
  const disabled = new Set(g.disabledBuiltins ?? []);
  const selected = new Set(g.mcpServers ?? []);
  const levels = g.capLevels ?? {};
  const assets = new Set(g.assets ?? []);
  const activeBuckets = new Set(cfg.agent?.buckets ?? []);

  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
  const box = "rounded-lg border border-border bg-surface-2 p-2.5";
  const sel = "rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand";

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-brand">
        <Sparkles size={13} /> {t("Capacidades de flota")}
      </p>

      {/* Modelo + razonamiento */}
      <div className="flex flex-wrap gap-3">
        <div>
          <span className={label}>{t("Modelo")}</span>
          <select
            className={sel}
            value={cfg.agent?.model ?? ""}
            disabled={busy === "model"}
            onChange={(e) => mut({ action: "set-model", model: e.target.value }, "model")}
          >
            {cfg.models?.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
        <div>
          <span className={label}>{t("Razonamiento")}</span>
          <select
            className={sel}
            value={cfg.agent?.effort ?? "medium"}
            disabled={busy === "effort"}
            onChange={(e) => mut({ action: "set-effort", effort: e.target.value }, "effort")}
          >
            {cfg.efforts?.map((ef) => (
              <option key={ef} value={ef}>{ef}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Prompt base del agente (persona.env.SYSTEM_PROMPT) — compartido por TODOS los
          canales del agente (WhatsApp, web…). Distinto de la persona local del room. */}
      <BasePrompt value={cfg.agent?.systemPrompt ?? ""} busy={busy === "prompt"} onSave={(p) => mut({ action: "set-agent-prompt", systemPrompt: p }, "prompt")} />

      {/* Herramientas (buckets EasyBits) */}
      <div>
        <span className={label}>{t("Herramientas")}</span>
        <div className="flex flex-wrap gap-1.5">
          {cfg.buckets?.map((b) => {
            const on = activeBuckets.has(b.key);
            return (
              <button
                key={b.key}
                title={b.description}
                disabled={busy === "buckets"}
                onClick={() => {
                  const next = new Set(activeBuckets);
                  on ? next.delete(b.key) : next.add(b.key);
                  mut({ action: "set-toolgroup", groupId: GROUP, buckets: [...next] }, "buckets");
                }}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  on ? "bg-brand text-brand-fg" : "bg-surface-3 text-muted hover:text-ink"
                }`}
              >
                {b.label}{b.admin ? " ★" : ""}
              </button>
            );
          })}
        </div>
      </div>

      {/* Conectores builtins (easybits / wa) */}
      <div>
        <span className={label}>{t("Incluidos")}</span>
        <div className="space-y-1">
          {cfg.builtins?.map((bi) => {
            const on = !disabled.has(bi.name);
            return (
              <label key={bi.name} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy === `bi:${bi.name}`}
                  onChange={() => mut({ action: "toggle-builtin", groupId: GROUP, builtin: bi.name, on: !on }, `bi:${bi.name}`)}
                />
                <span className="min-w-0 flex-1 truncate">{bi.label}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Conectores (curados + custom) con nivel de acceso + secrets */}
      {!!cfg.capabilities?.length && (
        <div>
          <span className={label}>{t("Conectores")}</span>
          <div className="space-y-2">
            {cfg.capabilities.map((c) => {
              const cur = selected.has(c.name) ? (levels[c.name] ?? (c.levels?.[0]?.key ?? "on")) : "off";
              const opts = c.levels ?? [{ key: "on", label: t("Activado") }];
              return (
                <div key={c.name} className={box}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {c.label}
                      {!c.curated && <span className="ml-1 text-[10px] text-muted">custom</span>}
                    </span>
                    <select
                      className={sel}
                      value={cur}
                      disabled={busy === `cap:${c.name}` || (!c.secretsPresent && !!c.requiredSecrets.length)}
                      onChange={(e) => mut({ action: "set-cap-level", groupId: GROUP, cap: c.name, level: e.target.value }, `cap:${c.name}`)}
                    >
                      <option value="off">{t("Off")}</option>
                      {opts.map((l) => (
                        <option key={l.key} value={l.key}>{l.label}</option>
                      ))}
                    </select>
                    {!c.curated && (
                      <button
                        onClick={() => mut({ action: "remove-mcp", name: c.name }, `cap:${c.name}`)}
                        className="text-muted hover:text-red-400"
                        title={t("Quitar")}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  {!!c.requiredSecrets.length && !c.secretsPresent && (
                    <SecretForm cap={c} busy={busy} onSave={(name, value) => mut({ action: "set-secret", name, value }, `cap:${c.name}`)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <AddMcpForm busy={busy} onAdd={(body) => mut(body, "addmcp")} />

      {/* Skills */}
      {!!cfg.skills?.length && (
        <div>
          <span className={label}>{t("Skills")}</span>
          <div className="space-y-1">
            {cfg.skills.map((s) => (
              <div key={s.id} className={`flex items-center gap-2 ${box}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{s.name}</p>
                  {s.description && <p className="truncate text-[11px] text-muted">{s.description}</p>}
                </div>
                <button
                  onClick={() => mut({ action: "toggle-skill", skillId: s.id, on: !s.enabled }, `sk:${s.id}`)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.enabled ? "bg-brand/15 text-brand" : "bg-surface-3 text-muted"}`}
                >
                  {s.enabled ? t("on") : t("off")}
                </button>
                <button onClick={() => mut({ action: "delete-skill", skillId: s.id }, `sk:${s.id}`)} className="text-muted hover:text-red-400" title={t("Quitar")}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Entregables (archivos que el agente puede enviar) */}
      <div>
        <span className={label}>{t("Entregables")}</span>
        <div className="mb-1.5 flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(q || undefined)}
            placeholder={t("Buscar un archivo…")}
            className={`flex-1 ${sel}`}
          />
          <button onClick={() => load(q || undefined)} className="rounded-lg border border-border px-2.5 text-xs text-muted hover:border-brand hover:text-ink">
            {t("Buscar")}
          </button>
        </div>
        <div className="space-y-1">
          {cfg.ownerFiles?.map((f) => {
            const on = assets.has(f.id);
            return (
              <label key={f.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy === `as:${f.id}`}
                  onChange={() => mut({ action: "toggle-asset", groupId: GROUP, fileId: f.id, on: !on }, `as:${f.id}`)}
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </label>
            );
          })}
          {!cfg.ownerFiles?.length && <p className="text-[11px] text-muted">{t("Busca por nombre para adjuntar entregables.")}</p>}
        </div>
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}

function BasePrompt({ value, busy, onSave }: { value: string; busy: boolean; onSave: (p: string) => void }) {
  const t = useT();
  const [val, setVal] = useState(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setVal(value); setDirty(false); }, [value]);
  return (
    <div>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{t("Prompt base (todos los canales)")}</span>
      <textarea
        value={val}
        onChange={(e) => { setVal(e.target.value); setDirty(true); }}
        rows={3}
        placeholder={t("Instrucciones base del agente (rol, tono, reglas)…")}
        className="w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-xs outline-none focus:border-brand"
      />
      {dirty && (
        <button
          onClick={() => onSave(val)}
          disabled={busy}
          className="mt-1 rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-brand-fg disabled:opacity-50"
        >
          {busy ? t("Guardando…") : t("Guardar prompt")}
        </button>
      )}
    </div>
  );
}

function SecretForm({ cap, busy, onSave }: { cap: Cap; busy: string | null; onSave: (name: string, value: string) => void }) {
  const t = useT();
  const secretName = cap.requiredSecrets[0];
  const field = cap.secretFields?.[secretName];
  const [val, setVal] = useState("");
  return (
    <div className="mt-2">
      <p className="mb-1 text-[11px] text-muted">{field?.label ?? secretName}{field?.help ? ` — ${field.help}` : ""}</p>
      <div className="flex gap-2">
        <input
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={t("Pega la credencial…")}
          className="flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand"
        />
        <button
          onClick={() => val.trim() && onSave(secretName, val.trim())}
          disabled={!val.trim() || busy === `cap:${cap.name}`}
          className="rounded-lg bg-brand px-3 text-xs font-semibold text-brand-fg disabled:opacity-50"
        >
          {t("Guardar")}
        </button>
      </div>
    </div>
  );
}

function AddMcpForm({ busy, onAdd }: { busy: string | null; onAdd: (body: Record<string, unknown>) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [secret, setSecret] = useState("");
  const input = "w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand";
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="flex items-center gap-1 text-xs text-muted hover:text-brand">
        <Plus size={13} /> {t("Añadir MCP avanzado")}
      </button>
    );
  const isUrl = /^https?:\/\//.test(pkg.trim());
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-2.5">
      <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder={t("nombre (ej. stripe)")} className={input} />
      <input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder={t("paquete npm (stdio) o URL https (http)")} className={input} />
      <input value={secret} onChange={(e) => setSecret(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder={t("secret opcional (ej. STRIPE_API_KEY)")} className={input} />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-ink">{t("Cancelar")}</button>
        <button
          onClick={() => {
            onAdd({ action: "add-mcp", name, ...(isUrl ? { url: pkg.trim() } : { pkg: pkg.trim() }), ...(secret ? { requiredSecret: secret } : {}) });
            setOpen(false); setName(""); setPkg(""); setSecret("");
          }}
          disabled={!name.trim() || !pkg.trim() || busy === "addmcp"}
          className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-brand-fg disabled:opacity-50"
        >
          {t("Añadir")}
        </button>
      </div>
    </div>
  );
}
