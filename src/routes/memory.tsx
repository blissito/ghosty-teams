import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Brain, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import {
  deleteRoomMemoryFn,
  deleteWorkspaceMemoryFn,
  listWorkspaceMemoryFn,
  saveWorkspaceMemoryFn,
} from "../server/memory";

// La memoria del workspace: lo que los agentes (y el equipo) han acordado recordar.
// Curaduría abierta a todos los miembros — un hecho falso que nadie puede corregir acaba
// dentro de un documento. Los agentes escriben por la tool memory_write; aquí se poda.

type MemoryData = Awaited<ReturnType<typeof listWorkspaceMemoryFn>>;
let memoryCache: MemoryData | null = null;

export const Route = createFileRoute("/memory")({
  loader: async () => ({ user: await me() }),
  component: MemoryPage,
});

function fmtDate(ts: number, locale: string): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function MemoryPage() {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<MemoryData | null>(memoryCache);
  const [editing, setEditing] = useState<{ id?: number; title: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);

  const reload = () =>
    listWorkspaceMemoryFn()
      .then((d) => {
        memoryCache = d;
        setData(d);
      })
      .catch(() => {});
  useEffect(() => {
    void reload();
  }, []);

  const save = () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    saveWorkspaceMemoryFn({ data: editing })
      .then((r) => {
        if (!r.ok) setError(r.error);
        else setEditing(null);
        return reload();
      })
      .catch(() => setError(t("No se pudo. Inténtalo otra vez.")))
      .finally(() => setBusy(false));
  };

  const removeWs = (id: number) => {
    setData((prev) => (prev ? { ...prev, workspace: prev.workspace.filter((n) => n.id !== id) } : prev));
    deleteWorkspaceMemoryFn({ data: { id } }).then(reload).catch(reload);
  };

  const removeRoom = (n: { id: number; scopeKey: string; agentHandle: string }) => {
    setData((prev) => (prev ? { ...prev, rooms: prev.rooms.filter((r) => r.id !== n.id) } : prev));
    deleteRoomMemoryFn({ data: { id: n.id, scopeKey: n.scopeKey, agentHandle: n.agentHandle } })
      .then(reload)
      .catch(reload);
  };

  const ws = data?.workspace ?? null;
  const limits = data?.limits;

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <Link
          to="/c/$slug"
          params={{ slug: "general" }}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink mb-4"
        >
          <ArrowLeft size={15} /> {t("Volver al chat")}
        </Link>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Brain size={22} className="text-brand" /> {t("Memoria del workspace")}
            </h1>
            <p className="text-muted text-sm mt-1">
              {t("Lo que tus agentes saben de la empresa: clientes, procesos, formatos. Lo usan en cualquier conversación — corrige o borra lo que ya no aplique.")}
            </p>
          </div>
          <button
            onClick={() => setEditing({ title: "", note: "" })}
            className="inline-flex items-center gap-1.5 text-xs font-semibold bg-brand text-brand-fg rounded-lg px-3 py-2 hover:brightness-110"
          >
            <Plus size={14} /> {t("Nueva nota")}
          </button>
        </header>

        {editing ? (
          <div className="gt-card rounded-2xl p-4 mb-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{editing.id ? t("Editar nota") : t("Nueva nota")}</span>
              <button onClick={() => setEditing(null)} className="text-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <input
              value={editing.title}
              maxLength={limits?.titleMax ?? 80}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              placeholder={t("Título — ej. Cliente ACME, facturación")}
              className="text-sm border border-border rounded-lg px-3 py-2 bg-surface-2"
            />
            <textarea
              value={editing.note}
              maxLength={limits?.maxChars ?? 600}
              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              placeholder={t("El hecho, corto y accionable")}
              rows={4}
              className="text-sm border border-border rounded-lg px-3 py-2 bg-surface-2 resize-y"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-faint">
                {editing.note.length}/{limits?.maxChars ?? 600}
              </span>
              <button
                disabled={busy || !editing.title.trim() || !editing.note.trim()}
                onClick={save}
                className="text-xs font-semibold bg-brand text-brand-fg rounded-lg px-4 py-2 disabled:opacity-50"
              >
                {t("Guardar")}
              </button>
            </div>
            {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
          </div>
        ) : null}

        {ws === null ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <li key={i} className="gt-card rounded-2xl p-4 animate-pulse">
                <div className="h-4 w-1/3 bg-surface-3 rounded mb-2" />
                <div className="h-3 w-2/3 bg-surface-3 rounded" />
              </li>
            ))}
          </ul>
        ) : ws.length === 0 ? (
          <div className="border border-dashed border-border rounded-2xl p-10 text-center text-muted text-sm">
            <p className="font-semibold text-ink mb-1">{t("Todavía no hay memoria")}</p>
            <p>
              {t("Pídele a un agente “recuerda para todo el workspace que…”, o sube un documento al chat y dile “guarda lo importante en la memoria del workspace”.")}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {ws.map((n) => (
              <li key={n.id} className="gt-card rounded-2xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-[15px]">{n.title}</div>
                    <p className="text-sm text-muted mt-1 whitespace-pre-wrap break-words">{n.note}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setEditing({ id: n.id, title: n.title, note: n.note })}
                      title={t("Editar")}
                      className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-surface-3"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => removeWs(n.id)}
                      title={t("Borrar")}
                      className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-surface-3"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="text-[11px] text-faint mt-2 flex items-center gap-2">
                  <span className="font-mono">ws:{n.id}</span>
                  {n.createdBy ? <span>· {n.createdBy}</span> : null}
                  <span>· {fmtDate(n.updatedAt, intlLocale(locale))}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {data && data.rooms.length > 0 ? (
          <section className="mt-8">
            <button
              onClick={() => setRoomsOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink"
            >
              {roomsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              {t("Por conversación")} <span className="text-faint font-normal">({data.rooms.length})</span>
            </button>
            {roomsOpen ? (
              <ul className="mt-3 flex flex-col gap-2">
                {data.rooms.map((n) => (
                  <li key={`${n.scopeKey}-${n.id}`} className="text-sm flex items-start gap-2 border border-border rounded-xl px-3 py-2">
                    <span className="text-xs text-faint shrink-0 mt-0.5 w-24 truncate">
                      {n.label} · @{n.agentHandle}
                    </span>
                    <span className="flex-1 min-w-0 break-words">{n.note}</span>
                    <button
                      onClick={() => removeRoom(n)}
                      title={t("Borrar")}
                      className="p-1 rounded text-muted hover:text-red-500 shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-faint mt-1">
                {t("Convenciones que cada agente guarda por room o DM. También se pueden podar desde aquí.")}
              </p>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
