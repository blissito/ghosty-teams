import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Plus, Trash2, Sparkles, Maximize2, Minimize2, KeyRound, Check, Upload } from "lucide-react";
import { useT } from "../i18n";
import { agentFleetConfigFn, setAgentFleetConfigFn } from "../server/agent-config";

// Panel de capacidades de un fleet agent. Lee/escribe en vivo la config de EasyBits
// vía el proxy server (fuente única). Mutaciones OPTIMISTAS con un REF al último estado
// (cfgRef) → toggles rápidos encadenan sobre el valor más reciente, no sobre el closure
// viejo (bug: al deseleccionar varias, "recuperaba" las otras). groupId "*" = default
// del agente (aplica a todo canal).
const GROUP = "*";

type Cap = {
  name: string; label: string; mode: string;
  requiredSecrets: string[]; secretFields: Record<string, { label: string; help?: string }>;
  secretsPresent: boolean; levels: { key: string; label: string }[] | null; curated: boolean;
};
type Bucket = { key: string; label: string; description: string; admin: boolean; levels: { key: string; label: string; buckets: string[] }[] | null };
type GroupCfg = { mcpServers?: string[]; disabledBuiltins?: string[]; capLevels?: Record<string, string>; assets?: string[]; dbAllow?: string[]; toolDeny?: string[]; systemPrompt?: string };
type Cfg = {
  fleet: boolean;
  builtins?: { name: string; label: string; channel?: string | null; bucketScoped?: boolean }[];
  capabilities?: Cap[];
  groups?: Record<string, GroupCfg>;
  ownerFiles?: { id: string; name: string; contentType?: string }[];
  ownerDbs?: { name: string; namespace: string }[];
  agent?: { systemPrompt: string; model: string; modelLabel?: string; effort: string; hasOwnNumber: boolean; buckets: string[] };
  buckets?: Bucket[];
  bucketTools?: Record<string, string[]>;
  models?: { key: string; label: string }[];
  efforts?: string[];
  skills?: { id: string; name: string; description: string; enabled: boolean; fileCount: number }[];
};

const clone = (c: Cfg): Cfg => (typeof structuredClone === "function" ? structuredClone(c) : JSON.parse(JSON.stringify(c)));
const gc = (c: Cfg): GroupCfg => { c.groups ??= {}; return (c.groups[GROUP] ??= {}); };

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-brand" : "bg-surface-3"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export function FleetCapabilities({ agentId }: { agentId: number }) {
  const t = useT();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const cfgRef = useRef<Cfg | null>(null); // último estado (para encadenar toggles rápidos)
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = (c: Cfg | null) => { cfgRef.current = c; setCfg(c); };
  const load = useCallback(
    (query?: string) =>
      agentFleetConfigFn({ data: { id: agentId, q: query } })
        .then((c) => { cfgRef.current = c as Cfg; setCfg(c as Cfg); })
        .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e))),
    [agentId]
  );
  useEffect(() => { load(); }, [load]);

  // Optimista sobre el ÚLTIMO estado (cfgRef): `build` muta el clon y devuelve el body a
  // persistir. cfgRef se actualiza síncrono → dos toggles seguidos no se pisan. En error,
  // re-sincroniza desde el server (fuente de verdad) en vez de revertir a un base viejo.
  async function mutate(key: string, build: (c: Cfg) => Record<string, unknown>, reload = false) {
    const cur = cfgRef.current;
    if (!cur) return;
    const next = clone(cur);
    const body = build(next);
    apply(next);
    setSaving((s) => [...s, key]);
    setErr(null);
    try {
      await setAgentFleetConfigFn({ data: { id: agentId, body } });
      if (reload) await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setSaving((s) => s.filter((k) => k !== key));
    }
  }
  const isSaving = (key: string) => saving.includes(key);

  async function uploadAsset(file: File) {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData(); fd.set("file", file);
      const res = await fetch(`/api/agent-asset?id=${agentId}`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (loadErr && !cfg) return <p className="px-1 py-2 text-xs text-red-400">{loadErr}</p>;
  if (!cfg) return <p className="flex items-center gap-2 px-1 py-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t("Cargando capacidades…")}</p>;

  const g = cfg.groups?.[GROUP] ?? {};
  const disabled = new Set(g.disabledBuiltins ?? []);
  const selected = new Set(g.mcpServers ?? []);
  const capLevels = g.capLevels ?? {};
  const assets = new Set(g.assets ?? []);
  const dbAllow = g.dbAllow ?? [];
  const activeBuckets = new Set(cfg.agent?.buckets ?? []);

  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
  const box = "rounded-lg border border-border bg-surface-2 p-2.5";
  const sel = "rounded-lg border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-brand";
  const Spin = ({ k }: { k: string }) => (isSaving(k) ? <Loader2 size={12} className="animate-spin text-brand" /> : null);

  // Per-tool deny: default = todas las tools del bucket ON; destildar = deny.
  const bucketTools = cfg.bucketTools ?? {};
  const denyList = new Set(cfg.groups?.[GROUP]?.toolDeny ?? []);
  // Tools reales de los sub-buckets ACTIVOS de un bucket (para el checklist).
  const bucketActiveTools = (b: Bucket) => {
    const keys = b.levels
      ? b.levels.flatMap((l) => l.buckets).filter((k) => activeBuckets.has(k))
      : (activeBuckets.has(b.key) ? [b.key] : []);
    return [...new Set(keys.flatMap((k) => bucketTools[k] ?? []))].sort();
  };
  const toggleTool = (tool: string, allow: boolean) => mutate(`deny:${tool}`, (c) => {
    const gg = gc(c); const set = new Set(gg.toolDeny ?? []);
    allow ? set.delete(tool) : set.add(tool);
    gg.toolDeny = [...set];
    return { action: "set-tool-deny", groupId: GROUP, tool, on: allow };
  });

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-brand">
        <Sparkles size={13} /> {t("Capacidades de flota")}
      </p>

      {/* Modelo (registry-driven: solo si el motor tiene modelos seleccionables) +
          razonamiento. Motores de modelo fijo (easybits) → sin selector. */}
      <div className="grid grid-cols-2 gap-3">
        {cfg.models?.length ? (
          <div>
            <span className={label}>{(cfg.agent?.modelLabel || t("Modelo"))} <Spin k="model" /></span>
            <select className={`w-full ${sel}`} value={cfg.agent?.model ?? ""} onChange={(e) => { const v = e.target.value; mutate("model", (c) => { if (c.agent) c.agent.model = v; return { action: "set-model", model: v }; }); }}>
              {cfg.models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
        ) : null}
        <div>
          <span className={label}>{t("Razonamiento")} <Spin k="effort" /></span>
          <select className={`w-full ${sel}`} value={cfg.agent?.effort ?? "medium"} onChange={(e) => { const v = e.target.value; mutate("effort", (c) => { if (c.agent) c.agent.effort = v; return { action: "set-effort", effort: v }; }); }}>
            {cfg.efforts?.map((ef) => <option key={ef} value={ef}>{ef}</option>)}
          </select>
        </div>
      </div>

      {/* Prompt base (todos los canales) = identidad del agente en TODAS partes. La
          personalidad SOLO-en-este-espacio vive en el campo "Persona local" (columna de
          identidad) → una sola fuente, sin duplicar. */}
      <BasePrompt value={cfg.agent?.systemPrompt ?? ""} saving={isSaving("prompt")} onSave={(p) => mutate("prompt", (c) => { if (c.agent) c.agent.systemPrompt = p; return { action: "set-agent-prompt", systemPrompt: p }; })} />

      {/* Herramientas (buckets) */}
      <div>
        <span className={label}>{t("Herramientas")} <Spin k="buckets" /></span>
        {/* Una fila por bucket: control (switch/nivel) + checklist per-tool inline
            + (DB) allow-list de bases. Todo en UN lugar por bucket (no secciones sueltas). */}
        <div className="flex flex-col gap-1.5">
          {(cfg.buckets ?? []).map((b) => {
            const isLevel = !!b.levels;
            const on = activeBuckets.has(b.key);
            const cur = isLevel
              ? ([...(b.levels ?? [])].reverse().find((l) => l.buckets.every((x) => activeBuckets.has(x)))?.key ?? "off")
              : (on ? "on" : "off");
            const isDb = b.key === "db";
            const ownerDbs = cfg.ownerDbs ?? [];
            const tools = bucketActiveTools(b);
            const activeCount = tools.filter((tn) => !denyList.has(tn)).length;
            return (
              <div key={b.key} className="rounded-lg border border-border p-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs" title={b.description}>
                    {b.label}{b.admin && <span className="text-muted"> ★</span>}
                  </span>
                  {isLevel ? (
                    <select
                      className={sel} value={cur}
                      onChange={(e) => { const lvlKey = e.target.value; mutate(`bucket:${b.key}`, (c) => {
                        if (!c.agent) return {};
                        const levelKeys = (b.levels ?? []).flatMap((l) => l.buckets);
                        const base = c.agent.buckets.filter((x) => !levelKeys.includes(x));
                        const lvl = (b.levels ?? []).find((l) => l.key === lvlKey);
                        c.agent.buckets = lvl ? [...base, ...lvl.buckets] : base;
                        return { action: "set-toolgroup", groupId: GROUP, buckets: c.agent.buckets };
                      }); }}
                    >
                      <option value="off">{t("Off")}</option>
                      {b.levels?.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                    </select>
                  ) : (
                    <Switch on={on} disabled={isSaving("buckets")} onChange={() => mutate("buckets", (c) => {
                      if (!c.agent) return {};
                      const set = new Set(c.agent.buckets);
                      set.has(b.key) ? set.delete(b.key) : set.add(b.key);
                      c.agent.buckets = [...set];
                      return { action: "set-toolgroup", groupId: GROUP, buckets: c.agent.buckets };
                    })} />
                  )}
                  <Spin k={isLevel ? `bucket:${b.key}` : "buckets"} />
                </div>
                {/* Per-tool: destildar herramientas puntuales (default todas ON). */}
                {tools.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer select-none text-[11px] text-muted">
                      {t("herramientas")} ({activeCount}/{tools.length})
                    </summary>
                    <div className="mt-1 max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-surface-2 p-2">
                      {tools.map((tn) => (
                        <div key={tn} className="flex items-center gap-2 text-[11px]">
                          <Switch on={!denyList.has(tn)} disabled={isSaving(`deny:${tn}`)} onChange={(v) => toggleTool(tn, v)} />
                          <span className="min-w-0 flex-1 truncate font-mono">{tn}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {/* DB: allow-list de QUÉ bases (vacío = todas). */}
                {isDb && cur !== "off" && (
                  <div className="mt-1.5 rounded-lg border border-border bg-surface-2 p-2">
                    <p className="mb-1.5 flex items-center gap-1 text-[11px] text-muted">{t("¿Qué bases puede tocar?")} <Spin k="dballow" /></p>
                    {ownerDbs.length ? (
                      <>
                        <div className="space-y-1.5">
                          {ownerDbs.map((d) => {
                            const dbOn = dbAllow.includes(d.namespace);
                            return (
                              <div key={d.namespace} className="flex items-center gap-2 text-xs">
                                <Switch on={dbOn} disabled={isSaving("dballow")} onChange={() => mutate("dballow", (c) => {
                                  const gg = gc(c); const set = new Set(gg.dbAllow ?? []);
                                  set.has(d.namespace) ? set.delete(d.namespace) : set.add(d.namespace);
                                  gg.dbAllow = [...set];
                                  return { action: "set-db-allow", groupId: GROUP, dbAllow: gg.dbAllow };
                                })} />
                                <span className="min-w-0 flex-1 truncate">{d.name} <span className="text-muted">/{d.namespace.slice(0, 8)}…</span></span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted">
                          {dbAllow.length === 0 ? t("Sin restricción: todas permitidas. Enciende alguna para limitar a solo esas.") : t("Restringido a {n} base(s).", { n: dbAllow.length })}
                        </p>
                      </>
                    ) : (
                      <p className="text-[11px] text-muted">{t("Este dueño no tiene bases creadas todavía.")}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Incluidos (builtins agnósticos: se ocultan channel/bucketScoped) */}
      {(() => {
        const visible = cfg.builtins?.filter((bi) => !bi.channel && !bi.bucketScoped) ?? [];
        if (!visible.length) return null;
        return (
          <div>
            <span className={label}>{t("Incluidos")}</span>
            <div className="space-y-1.5">
              {visible.map((bi) => {
                const on = !disabled.has(bi.name);
                return (
                  <div key={bi.name} className="flex items-center gap-2 text-xs">
                    <Switch on={on} disabled={isSaving(`bi:${bi.name}`)} onChange={(v) => mutate(`bi:${bi.name}`, (c) => {
                      const gg = gc(c); const set = new Set(gg.disabledBuiltins ?? []);
                      v ? set.delete(bi.name) : set.add(bi.name);
                      gg.disabledBuiltins = [...set];
                      return { action: "toggle-builtin", groupId: GROUP, builtin: bi.name, on: v };
                    })} />
                    <span className="min-w-0 flex-1 truncate">{bi.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Conectores (curados + custom): nivel + credencial colapsada */}
      {!!cfg.capabilities?.length && (
        <div>
          <span className={label}>{t("Conectores")}</span>
          <div className="space-y-2">
            {cfg.capabilities.map((c) => (
              <Connector
                key={c.name} cap={c} box={box} sel={sel} saving={isSaving(`cap:${c.name}`)}
                cur={selected.has(c.name) ? (capLevels[c.name] ?? c.levels?.[0]?.key ?? "on") : "off"}
                onLevel={(level) => mutate(`cap:${c.name}`, (x) => {
                  const gg = gc(x); const set = new Set(gg.mcpServers ?? []); const lv = { ...(gg.capLevels ?? {}) };
                  if (level === "off") { set.delete(c.name); delete lv[c.name]; } else { set.add(c.name); lv[c.name] = level; }
                  gg.mcpServers = [...set]; gg.capLevels = lv;
                  return { action: "set-cap-level", groupId: GROUP, cap: c.name, level };
                })}
                onSecret={(name, value) => mutate(`cap:${c.name}`, (x) => { const cc = x.capabilities?.find((e) => e.name === c.name); if (cc) cc.secretsPresent = true; return { action: "set-secret", name, value }; })}
                onRemove={!c.curated ? () => mutate(`cap:${c.name}`, (x) => { x.capabilities = x.capabilities?.filter((e) => e.name !== c.name); return { action: "remove-mcp", name: c.name }; }) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      <AddMcpForm saving={isSaving("addmcp")} onAdd={(body) => mutate("addmcp", () => body, true)} />

      {/* Skills */}
      {!!cfg.skills?.length && (
        <div>
          <span className={label}>{t("Skills")}</span>
          <div className="space-y-1">
            {cfg.skills.map((s) => (
              <div key={s.id} className={`flex items-center gap-2 ${box}`}>
                <Switch on={s.enabled} disabled={isSaving(`sk:${s.id}`)} onChange={(v) => mutate(`sk:${s.id}`, (c) => { const sk = c.skills?.find((x) => x.id === s.id); if (sk) sk.enabled = v; return { action: "toggle-skill", skillId: s.id, on: v }; })} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{s.name}</p>
                  {s.description && <p className="truncate text-[11px] text-muted">{s.description}</p>}
                </div>
                <Spin k={`sk:${s.id}`} />
                <button onClick={() => mutate(`sk:${s.id}`, (c) => { c.skills = c.skills?.filter((x) => x.id !== s.id); return { action: "delete-skill", skillId: s.id }; })} className="text-muted hover:text-red-400" title={t("Quitar")}>
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
          {/* Buscar entregables por nombre — DESACTIVADO (la búsqueda no filtra bien todavía).
              Reactivar restaurando el estado `q`/`setQ` + `load(q || undefined)`:
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(q || undefined)} placeholder={t("Buscar un archivo…")} className={`flex-1 ${sel}`} />
          <button onClick={() => load(q || undefined)} className="rounded-lg border border-border px-2.5 text-xs text-muted hover:border-brand hover:text-ink">{t("Buscar")}</button>
          */}
          <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAsset(f); }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:border-brand hover:text-ink disabled:opacity-50" title={t("Subir a EasyBits")}>
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} {t("Subir entregable")}
          </button>
        </div>
        <div className="space-y-1.5">
          {cfg.ownerFiles?.map((f) => {
            const on = assets.has(f.id);
            return (
              <div key={f.id} className="flex items-center gap-2 text-xs">
                <Switch on={on} disabled={isSaving(`as:${f.id}`)} onChange={(v) => mutate(`as:${f.id}`, (c) => {
                  const gg = gc(c); const set = new Set(gg.assets ?? []); v ? set.add(f.id) : set.delete(f.id); gg.assets = [...set];
                  return { action: "toggle-asset", groupId: GROUP, fileId: f.id, on: v };
                })} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </div>
            );
          })}
          {!cfg.ownerFiles?.length && <p className="text-[11px] text-muted">{t("Sube un archivo para adjuntar entregables.")}</p>}
        </div>
      </div>

      {err && <p className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}

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

function BasePrompt({ value, saving, onSave, title, placeholder, hint }: { value: string; saving: boolean; onSave: (p: string) => void; title?: string; placeholder?: string; hint?: string }) {
  const t = useT();
  const [val, setVal] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => { setVal(value); setDirty(false); }, [value]);
  return (
    <div>
      <span className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>{title ?? t("Prompt base (todos los canales)")}</span>
        <button onClick={() => setBig((v) => !v)} className="text-muted hover:text-brand" title={big ? t("Contraer") : t("Expandir")}>
          {big ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </span>
      {hint && <p className="mb-1 text-[11px] leading-snug text-muted">{hint}</p>}
      <textarea
        value={val} onChange={(e) => { setVal(e.target.value); setDirty(true); }} rows={big ? 22 : 5}
        placeholder={placeholder ?? t("Instrucciones base del agente (rol, tono, reglas)…")}
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
