import { useEffect, useState, useCallback } from "react";
import { Loader2, Plus, Trash2, Sparkles, Maximize2, Minimize2, KeyRound, Check } from "lucide-react";
import { useT } from "../i18n";
import { agentFleetConfigFn, setAgentFleetConfigFn } from "../server/agent-config";

// Panel de capacidades de un fleet agent. Lee/escribe en vivo la config de EasyBits
// vía el proxy server (fuente única). Mutaciones OPTIMISTAS: aplicamos el cambio al
// estado local al instante y persistimos en background (revert + error si falla) →
// los controles no "rebotan" al valor viejo esperando el round-trip. groupId "*" =
// default del agente (aplica a todo canal). Espeja el modal 2-col del dash EasyBits.
const GROUP = "*";

type Cap = {
  name: string; label: string; mode: string;
  requiredSecrets: string[]; secretFields: Record<string, { label: string; help?: string }>;
  secretsPresent: boolean; levels: { key: string; label: string }[] | null; curated: boolean;
};
type Bucket = { key: string; label: string; description: string; admin: boolean; levels: { key: string; label: string; buckets: string[] }[] | null };
type GroupCfg = { mcpServers?: string[]; disabledBuiltins?: string[]; capLevels?: Record<string, string>; assets?: string[] };
type Cfg = {
  fleet: boolean;
  builtins?: { name: string; label: string; channel?: string | null; bucketScoped?: boolean }[];
  capabilities?: Cap[];
  groups?: Record<string, GroupCfg>;
  ownerFiles?: { id: string; name: string; contentType?: string }[];
  agent?: { systemPrompt: string; model: string; effort: string; hasOwnNumber: boolean; buckets: string[] };
  buckets?: Bucket[];
  models?: { key: string; label: string }[];
  efforts?: string[];
  skills?: { id: string; name: string; description: string; enabled: boolean; fileCount: number }[];
};

const clone = (c: Cfg): Cfg => (typeof structuredClone === "function" ? structuredClone(c) : JSON.parse(JSON.stringify(c)));
const gc = (c: Cfg): GroupCfg => (c.groups ??= {})[GROUP] ?? ((c.groups[GROUP] = {}), c.groups[GROUP]);

export function FleetCapabilities({ agentId }: { agentId: number }) {
  const t = useT();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string[]>([]);
  const [q, setQ] = useState("");

  const load = useCallback(
    (query?: string) =>
      agentFleetConfigFn({ data: { id: agentId, q: query } })
        .then((c) => setCfg(c as Cfg))
        .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e))),
    [agentId]
  );
  useEffect(() => { load(); }, [load]);

  // Optimista: aplica `patch` al estado, persiste, revierte si falla. `key` marca el
  // control con spinner. `reload` re-sincroniza tras éxito (para add-mcp/entregables).
  async function mutate(body: Record<string, unknown>, key: string, patch: (c: Cfg) => void, reload = false) {
    if (!cfg) return;
    const snapshot = cfg;
    const next = clone(cfg);
    patch(next);
    setCfg(next);
    setSaving((s) => [...s, key]);
    setErr(null);
    try {
      await setAgentFleetConfigFn({ data: { id: agentId, body } });
      if (reload) await load(q || undefined);
    } catch (e) {
      setCfg(snapshot);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving((s) => s.filter((k) => k !== key));
    }
  }
  const isSaving = (key: string) => saving.includes(key);

  if (loadErr && !cfg) return <p className="px-1 py-2 text-xs text-red-400">{loadErr}</p>;
  if (!cfg) return <p className="flex items-center gap-2 px-1 py-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t("Cargando capacidades…")}</p>;

  const g = cfg.groups?.[GROUP] ?? {};
  const disabled = new Set(g.disabledBuiltins ?? []);
  const selected = new Set(g.mcpServers ?? []);
  const capLevels = g.capLevels ?? {};
  const assets = new Set(g.assets ?? []);
  const activeBuckets = new Set(cfg.agent?.buckets ?? []);

  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
  const box = "rounded-lg border border-border bg-surface-2 p-2.5";
  const sel = "rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand";
  const Spin = ({ k }: { k: string }) => (isSaving(k) ? <Loader2 size={12} className="animate-spin text-brand" /> : null);

  // Buckets sin niveles = chips toggle; con niveles (db) = select granular.
  const chipBuckets = cfg.buckets?.filter((b) => !b.levels) ?? [];
  const levelBuckets = cfg.buckets?.filter((b) => b.levels) ?? [];
  const setBuckets = (list: string[], key: string) =>
    mutate({ action: "set-toolgroup", groupId: GROUP, buckets: list }, key, (c) => { if (c.agent) c.agent.buckets = list; });

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-brand">
        <Sparkles size={13} /> {t("Capacidades de flota")}
      </p>

      {/* Modelo + razonamiento */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className={label}>{t("Modelo")} <Spin k="model" /></span>
          <select className={`w-full ${sel}`} value={cfg.agent?.model ?? ""} onChange={(e) => mutate({ action: "set-model", model: e.target.value }, "model", (c) => { if (c.agent) c.agent.model = e.target.value; })}>
            {cfg.models?.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <span className={label}>{t("Razonamiento")} <Spin k="effort" /></span>
          <select className={`w-full ${sel}`} value={cfg.agent?.effort ?? "medium"} onChange={(e) => mutate({ action: "set-effort", effort: e.target.value }, "effort", (c) => { if (c.agent) c.agent.effort = e.target.value; })}>
            {cfg.efforts?.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
          </select>
        </div>
      </div>

      {/* Prompt base (todos los canales) — expandible */}
      <BasePrompt value={cfg.agent?.systemPrompt ?? ""} saving={isSaving("prompt")} onSave={(p) => mutate({ action: "set-agent-prompt", systemPrompt: p }, "prompt", (c) => { if (c.agent) c.agent.systemPrompt = p; })} />

      {/* Herramientas (buckets) */}
      <div>
        <span className={label}>{t("Herramientas")} <Spin k="buckets" /></span>
        <div className="flex flex-wrap gap-1.5">
          {chipBuckets.map((b) => {
            const on = activeBuckets.has(b.key);
            return (
              <button
                key={b.key}
                title={b.description}
                onClick={() => setBuckets(on ? [...activeBuckets].filter((x) => x !== b.key) : [...activeBuckets, b.key], "buckets")}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${on ? "bg-brand text-brand-fg" : "bg-surface-3 text-muted hover:text-ink"}`}
              >
                {b.label}
              </button>
            );
          })}
        </div>
        {/* Buckets granulares (Bases de datos: lectura/escritura/borrado) */}
        {levelBuckets.map((b) => {
          const cur = [...(b.levels ?? [])].reverse().find((l) => l.buckets.every((x) => activeBuckets.has(x)))?.key ?? "off";
          const base = [...activeBuckets].filter((x) => !(b.levels ?? []).some((l) => l.buckets.includes(x)));
          return (
            <div key={b.key} className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs" title={b.description}>{b.label} <span className="text-muted">★</span></span>
              <select
                className={sel}
                value={cur}
                onChange={(e) => {
                  const lvl = (b.levels ?? []).find((l) => l.key === e.target.value);
                  setBuckets(lvl ? [...base, ...lvl.buckets] : base, `bucket:${b.key}`);
                }}
              >
                <option value="off">{t("Off")}</option>
                {b.levels?.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
              <Spin k={`bucket:${b.key}`} />
            </div>
          );
        })}
      </div>

      {/* Incluidos (builtins) — solo los que NO están ya representados en otra parte:
          `channel` (ej. wa/WhatsApp, no aplica a GTeams) y `bucketScoped` (easybits, ya
          controlado por HERRAMIENTAS → un on/off aparte sería redundante con el granular).
          Si no queda ninguno, la sección no se muestra. */}
      {(() => {
        const visible = cfg.builtins?.filter((bi) => !bi.channel && !bi.bucketScoped) ?? [];
        if (!visible.length) return null;
        return (
          <div>
            <span className={label}>{t("Incluidos")}</span>
            <div className="space-y-1">
              {visible.map((bi) => {
                const on = !disabled.has(bi.name);
                return (
                  <label key={bi.name} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={on} onChange={() => mutate({ action: "toggle-builtin", groupId: GROUP, builtin: bi.name, on: !on }, `bi:${bi.name}`, (c) => {
                      const gg = gc(c); const set = new Set(gg.disabledBuiltins ?? []); on ? set.add(bi.name) : set.delete(bi.name); gg.disabledBuiltins = [...set];
                    })} />
                    <span className="min-w-0 flex-1 truncate">{bi.label}</span>
                    <Spin k={`bi:${bi.name}`} />
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Conectores (curados + custom) */}
      {!!cfg.capabilities?.length && (
        <div>
          <span className={label}>{t("Conectores")}</span>
          <div className="space-y-2">
            {cfg.capabilities.map((c) => (
              <Connector
                key={c.name} cap={c} box={box} sel={sel} saving={isSaving(`cap:${c.name}`)}
                cur={selected.has(c.name) ? (capLevels[c.name] ?? c.levels?.[0]?.key ?? "on") : "off"}
                onLevel={(level) => mutate({ action: "set-cap-level", groupId: GROUP, cap: c.name, level }, `cap:${c.name}`, (x) => {
                  const gg = gc(x); const set = new Set(gg.mcpServers ?? []); const lv = { ...(gg.capLevels ?? {}) };
                  if (level === "off") { set.delete(c.name); delete lv[c.name]; } else { set.add(c.name); lv[c.name] = level; }
                  gg.mcpServers = [...set]; gg.capLevels = lv;
                })}
                onSecret={(name, value) => mutate({ action: "set-secret", name, value }, `cap:${c.name}`, (x) => { const cc = x.capabilities?.find((e) => e.name === c.name); if (cc) cc.secretsPresent = true; })}
                onRemove={!c.curated ? () => mutate({ action: "remove-mcp", name: c.name }, `cap:${c.name}`, (x) => { x.capabilities = x.capabilities?.filter((e) => e.name !== c.name); }) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      <AddMcpForm saving={isSaving("addmcp")} onAdd={(body) => mutate(body, "addmcp", () => {}, true)} />

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
                <Spin k={`sk:${s.id}`} />
                <button onClick={() => mutate({ action: "toggle-skill", skillId: s.id, on: !s.enabled }, `sk:${s.id}`, (c) => { const sk = c.skills?.find((x) => x.id === s.id); if (sk) sk.enabled = !s.enabled; })}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.enabled ? "bg-brand/15 text-brand" : "bg-surface-3 text-muted"}`}>
                  {s.enabled ? t("on") : t("off")}
                </button>
                <button onClick={() => mutate({ action: "delete-skill", skillId: s.id }, `sk:${s.id}`, (c) => { c.skills = c.skills?.filter((x) => x.id !== s.id); })} className="text-muted hover:text-red-400" title={t("Quitar")}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Entregables */}
      <div>
        <span className={label}>{t("Entregables")}</span>
        <div className="mb-1.5 flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(q || undefined)} placeholder={t("Buscar un archivo…")} className={`flex-1 ${sel}`} />
          <button onClick={() => load(q || undefined)} className="rounded-lg border border-border px-2.5 text-xs text-muted hover:border-brand hover:text-ink">{t("Buscar")}</button>
        </div>
        <div className="space-y-1">
          {cfg.ownerFiles?.map((f) => {
            const on = assets.has(f.id);
            return (
              <label key={f.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={on} onChange={() => mutate({ action: "toggle-asset", groupId: GROUP, fileId: f.id, on: !on }, `as:${f.id}`, (c) => {
                  const gg = gc(c); const set = new Set(gg.assets ?? []); on ? set.delete(f.id) : set.add(f.id); gg.assets = [...set];
                })} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <Spin k={`as:${f.id}`} />
              </label>
            );
          })}
          {!cfg.ownerFiles?.length && <p className="text-[11px] text-muted">{t("Busca por nombre para adjuntar entregables.")}</p>}
        </div>
      </div>

      {err && <p className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}

// Un conector: nivel de acceso + (si le falta credencial) botón Conectar que revela
// el input — NO se muestra expandido de entrada.
function Connector({ cap, box, sel, saving, cur, onLevel, onSecret, onRemove }: {
  cap: Cap; box: string; sel: string; saving: boolean; cur: string;
  onLevel: (level: string) => void; onSecret: (name: string, value: string) => void; onRemove?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const needsKey = !!cap.requiredSecrets.length && !cap.secretsPresent;
  const opts = cap.levels ?? [{ key: "on", label: t("Activado") }];
  const secretName = cap.requiredSecrets[0];
  const field = cap.secretFields?.[secretName];
  return (
    <div className={box}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {cap.label}{!cap.curated && <span className="ml-1 text-[10px] text-muted">custom</span>}
        </span>
        {saving && <Loader2 size={12} className="animate-spin text-brand" />}
        {needsKey ? (
          <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-muted hover:border-brand hover:text-ink">
            <KeyRound size={11} /> {t("Conectar")}
          </button>
        ) : (
          <select className={sel} value={cur} onChange={(e) => onLevel(e.target.value)}>
            <option value="off">{t("Off")}</option>
            {opts.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
        )}
        {onRemove && <button onClick={onRemove} className="text-muted hover:text-red-400" title={t("Quitar")}><Trash2 size={13} /></button>}
      </div>
      {needsKey && open && (
        <div className="mt-2">
          <p className="mb-1 text-[11px] text-muted">{field?.label ?? secretName}{field?.help ? ` — ${field.help}` : ""}</p>
          <div className="flex gap-2">
            <input type="password" value={val} onChange={(e) => setVal(e.target.value)} placeholder={t("Pega la credencial…")} className="flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand" />
            <button onClick={() => { if (val.trim()) { onSecret(secretName, val.trim()); setOpen(false); setVal(""); } }} disabled={!val.trim() || saving} className="flex items-center gap-1 rounded-lg bg-brand px-3 text-xs font-semibold text-brand-fg disabled:opacity-50"><Check size={12} /> {t("Guardar")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BasePrompt({ value, saving, onSave }: { value: string; saving: boolean; onSave: (p: string) => void }) {
  const t = useT();
  const [val, setVal] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => { setVal(value); setDirty(false); }, [value]);
  return (
    <div>
      <span className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>{t("Prompt base (todos los canales)")}</span>
        <button onClick={() => setBig((v) => !v)} className="text-muted hover:text-brand" title={big ? t("Contraer") : t("Expandir")}>
          {big ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </span>
      <textarea
        value={val}
        onChange={(e) => { setVal(e.target.value); setDirty(true); }}
        rows={big ? 22 : 5}
        placeholder={t("Instrucciones base del agente (rol, tono, reglas)…")}
        className="thin-scroll w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-brand"
      />
      {dirty && (
        <button onClick={() => onSave(val)} disabled={saving} className="mt-1 flex items-center gap-1 rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-brand-fg disabled:opacity-50">
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {t("Guardar prompt")}
        </button>
      )}
    </div>
  );
}

function AddMcpForm({ saving, onAdd }: { saving: boolean; onAdd: (body: Record<string, unknown>) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [secret, setSecret] = useState("");
  const input = "w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand";
  if (!open) return <button onClick={() => setOpen(true)} className="flex items-center gap-1 text-xs text-muted hover:text-brand"><Plus size={13} /> {t("Añadir MCP avanzado")}</button>;
  const isUrl = /^https?:\/\//.test(pkg.trim());
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-2.5">
      <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder={t("nombre (ej. stripe)")} className={input} />
      <input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder={t("paquete npm (stdio) o URL https (http)")} className={input} />
      <input value={secret} onChange={(e) => setSecret(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder={t("secret opcional (ej. STRIPE_API_KEY)")} className={input} />
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-ink">{t("Cancelar")}</button>
        <button
          onClick={() => { onAdd({ action: "add-mcp", name, ...(isUrl ? { url: pkg.trim() } : { pkg: pkg.trim() }), ...(secret ? { requiredSecret: secret } : {}) }); setOpen(false); setName(""); setPkg(""); setSecret(""); }}
          disabled={!name.trim() || !pkg.trim() || saving}
          className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-brand-fg disabled:opacity-50">{t("Añadir")}</button>
      </div>
    </div>
  );
}
