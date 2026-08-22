import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import { useLocale, useT } from "../i18n";
import { intlLocale } from "../i18n.core";
import { me } from "../server/auth";
import { askDmAgentFn, postDmMessageFn } from "../server/dm";
import {
  deleteMemoryDocFn,
  deleteRoomMemoryFn,
  deleteWorkspaceMemoryFn,
  ingestMemoryDocFn,
  listWorkspaceMemoryFn,
  retryMemoryDocFn,
  saveRoomRuleFn,
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
  const navigate = useNavigate();
  const { user } = Route.useLoaderData();
  const [data, setData] = useState<MemoryData | null>(memoryCache);
  const [editing, setEditing] = useState<{
    id?: number;
    title: string;
    note: string;
    attachment?: { fileId: string; name: string; mime: string; size: number } | null;
  } | null>(null);
  const [attaching, setAttaching] = useState(false);
  // Confirmación destructiva con el modal de la casa, no el confirm() nativo.
  const [confirming, setConfirming] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    action: () => void;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  // Borrador de un LINEAMIENTO del espacio (agnóstico del agente). Las notas por agente no
  // se editan desde aquí: son suyas, y aquí sólo se podan.
  const [rule, setRule] = useState<{ id?: number; channelId: number; note: string } | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ingesting, setIngesting] = useState<string | null>(null); // nombre del archivo en vuelo
  const [ingestError, setIngestError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const noteFileInput = useRef<HTMLInputElement>(null);

  // Adjunto de una nota: sube el archivo y lo deja en el borrador; al guardar se
  // registra como documento fuente (sin destilación) y la nota lo liga por source_ref.
  const attachToNote = async (file: File) => {
    setAttaching(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: form });
      if (!up.ok) {
        throw new Error(
          up.status === 413 ? t("El archivo pasa de 25MB. Comprímelo o divídelo.") : `upload ${up.status}`
        );
      }
      const meta = (await up.json()) as { fileId: string; mime?: string; size?: number };
      setEditing((prev) =>
        prev
          ? {
              ...prev,
              attachment: {
                fileId: meta.fileId,
                name: file.name,
                mime: meta.mime ?? file.type,
                size: meta.size ?? file.size,
              },
            }
          : prev
      );
    } catch (e) {
      setError((e as Error).message || t("No se pudo. Inténtalo otra vez."));
    } finally {
      setAttaching(false);
    }
  };

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

  const removeWs = (n: { id: number; title: string }) => {
    setConfirming({
      title: t("¿Borrar esta nota?"),
      body: t("«{title}» — los agentes dejarán de saberlo. No se puede deshacer.", { title: n.title }),
      confirmLabel: t("Borrar"),
      action: () => {
        setData((prev) => (prev ? { ...prev, workspace: prev.workspace.filter((x) => x.id !== n.id) } : prev));
        deleteWorkspaceMemoryFn({ data: { id: n.id } }).then(reload).catch(reload);
      },
    });
  };

  const saveRule = () => {
    if (!rule) return;
    setBusy(true);
    setRuleError(null);
    saveRoomRuleFn({ data: rule })
      .then((r) => {
        if (!r.ok) setRuleError(r.error);
        else setRule(null);
        return reload();
      })
      .catch(() => setRuleError(t("No se pudo. Inténtalo otra vez.")))
      .finally(() => setBusy(false));
  };

  const removeRoom = (n: { id: number; scopeKey: string; agentHandle: string }) => {
    const esRegla = n.agentHandle === "";
    setConfirming({
      title: esRegla ? t("¿Borrar este lineamiento?") : t("¿Borrar esta nota?"),
      body: esRegla
        ? t("Ningún agente lo seguirá en ese espacio. No se puede deshacer.")
        : t("El agente dejará de saberlo en esa conversación. No se puede deshacer."),
      confirmLabel: t("Borrar"),
      action: () => {
        setData((prev) => (prev ? { ...prev, rooms: prev.rooms.filter((r) => r.id !== n.id) } : prev));
        deleteRoomMemoryFn({ data: { id: n.id, scopeKey: n.scopeKey, agentHandle: n.agentHandle } })
          .then(reload)
          .catch(reload);
      },
    });
  };

  const removeDoc = (d: { id: number; name: string }) => {
    setConfirming({
      title: t("¿Quitar este documento?"),
      body: t("«{name}» sale de la lista; las notas ya destiladas se quedan.", { name: d.name }),
      confirmLabel: t("Quitar"),
      action: () => {
        setData((prev) => (prev ? { ...prev, docs: prev.docs.filter((x) => x.id !== d.id) } : prev));
        deleteMemoryDocFn({ data: { id: d.id } }).then(reload).catch(reload);
      },
    });
  };

  // Documento soltado → subir → registrar (abre el DM con el agente) → postear la
  // instrucción con el adjunto. El turno corre por el camino normal del chat; aquí
  // sólo se le da play y se enlaza la conversación.
  const ingestFile = async (file: File) => {
    setIngestError(null);
    setIngesting(file.name);
    try {
      const form = new FormData();
      form.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: form });
      if (!up.ok) {
        throw new Error(
          up.status === 413 ? t("El archivo pasa de 25MB. Comprímelo o divídelo.") : `upload ${up.status}`
        );
      }
      const meta = (await up.json()) as { fileId: string; mime?: string; size?: number };
      const r = await ingestMemoryDocFn({
        data: { fileId: meta.fileId, name: file.name, mime: meta.mime ?? file.type, size: meta.size ?? file.size },
      });
      if (!r.ok) throw new Error(r.error);
      await sendToAgent(r.dmId, r.body, {
        fileId: meta.fileId,
        mime: meta.mime ?? file.type,
        size: meta.size ?? file.size,
        name: file.name,
      });
    } catch (e) {
      setIngestError((e as Error).message || t("No se pudo. Inténtalo otra vez."));
    } finally {
      setIngesting(null);
    }
  };

  // Postea la instrucción con el adjunto Y dispara el turno.
  // ⚠️ postDmMessageFn sólo deja el mensaje y la cáscara del agente: el TURNO lo
  // dispara el cliente con askDmAgentFn (igual que el composer del chat). Sin esa
  // llamada la cáscara se queda en "pensando…" para siempre.
  const sendToAgent = async (
    dmId: number,
    body: string,
    attachment: { fileId: string; mime: string; size: number; name: string }
  ) => {
    const posted = await postDmMessageFn({ data: { id: dmId, body, attachments: [attachment] } });
    if (posted.ok && posted.needsAgent && posted.agentHandle) {
      void askDmAgentFn({
        data: {
          id: dmId,
          body,
          sender: user?.name ?? "",
          handle: posted.agentHandle,
          shellId: posted.shellId ?? undefined,
          attachments: [attachment],
        },
      }).catch(() => {});
    }
    await reload();
    // Al DM: ahí se ve al agente destilando en vivo.
    void navigate({ to: "/c/$slug", params: { slug: "general" }, search: { dm: dmId } as never });
  };

  const retryDoc = async (id: number) => {
    setIngestError(null);
    setIngesting(t("reintento"));
    try {
      const r = await retryMemoryDocFn({ data: { id } });
      if (!r.ok) throw new Error(r.error);
      await sendToAgent(r.dmId, r.body, r.attachment);
    } catch (e) {
      setIngestError((e as Error).message || t("No se pudo. Inténtalo otra vez."));
    } finally {
      setIngesting(null);
    }
  };

  const ws = data?.workspace ?? null;
  const limits = data?.limits;
  const docs = data?.docs ?? [];
  const docsByRef = new Map(docs.map((d) => [`doc:${d.id}`, d]));

  return (
    <div
      className="min-h-screen bg-surface text-ink"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void ingestFile(file);
      }}
    >
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
            {editing.attachment ? (
              <div className="flex items-center gap-2 text-xs border border-border rounded-lg px-2.5 py-1.5 self-start max-w-full">
                {editing.attachment.mime.startsWith("image/") ? (
                  <img
                    src={`/api/attachment/${editing.attachment.fileId}`}
                    alt=""
                    className="h-8 w-8 rounded object-cover shrink-0"
                  />
                ) : (
                  <FileText size={14} className="text-brand shrink-0" />
                )}
                <span className="truncate">{editing.attachment.name}</span>
                <button
                  onClick={() => setEditing({ ...editing, attachment: null })}
                  title={t("Quitar adjunto")}
                  className="text-muted hover:text-ink shrink-0"
                >
                  <X size={13} />
                </button>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-faint">
                  {editing.note.length}/{limits?.maxChars ?? 600}
                </span>
                <button
                  onClick={() => noteFileInput.current?.click()}
                  disabled={attaching}
                  title={t("Adjuntar archivo o imagen")}
                  className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-surface-3 disabled:opacity-50"
                >
                  {attaching ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                </button>
              </div>
              <button
                disabled={busy || attaching || !editing.title.trim() || !editing.note.trim()}
                onClick={save}
                className="text-xs font-semibold bg-brand text-brand-fg rounded-lg px-4 py-2 disabled:opacity-50"
              >
                {t("Guardar")}
              </button>
            </div>
            <input
              ref={noteFileInput}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void attachToNote(file);
              }}
            />
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
                      onClick={() => removeWs(n)}
                      title={t("Borrar")}
                      className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-surface-3"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {(() => {
                  const doc = n.sourceRef ? docsByRef.get(n.sourceRef) : undefined;
                  return (
                    <>
                      {doc?.mime?.startsWith("image/") ? (
                        <a href={`/api/attachment/${doc.fileId}`} target="_blank" rel="noreferrer">
                          <img
                            src={`/api/attachment/${doc.fileId}`}
                            alt={doc.name}
                            className="mt-2 h-24 rounded-lg object-cover border border-border"
                          />
                        </a>
                      ) : null}
                      <div className="text-[11px] text-faint mt-2 flex items-center gap-2 flex-wrap">
                        <span className="font-mono">ws:{n.id}</span>
                        {n.createdBy ? <span>· {n.createdBy}</span> : null}
                        <span>· {fmtDate(n.updatedAt, intlLocale(locale))}</span>
                        {doc ? (
                          <a
                            href={`/api/attachment/${doc.fileId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-muted hover:text-ink"
                          >
                            · <FileText size={11} /> {doc.name}
                          </a>
                        ) : null}
                      </div>
                    </>
                  );
                })()}
              </li>
            ))}
          </ul>
        )}

        {/* Documentos fuente: se sueltan aquí, el agente los destila a notas en su DM. */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-muted mb-3">{t("Documentos")}</h2>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={ingesting !== null}
            className={`w-full border-2 border-dashed rounded-2xl p-6 text-center text-sm transition ${
              dragging ? "border-brand bg-brand/5 text-ink" : "border-border text-muted hover:border-brand/50"
            }`}
          >
            {ingesting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" /> {t("Subiendo")} {ingesting}…
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Upload size={16} />
                {t("Suelta un documento (o haz clic): el agente lo lee y lo destila a notas de memoria.")}
              </span>
            )}
          </button>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void ingestFile(file);
            }}
          />
          {ingestError ? <p className="text-[11px] text-red-500 mt-2">{ingestError}</p> : null}
          {docs.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {docs.map((d) => (
                <li key={d.id} className="text-sm flex items-center gap-3 border border-border rounded-xl px-3 py-2">
                  <FileText size={16} className="text-brand shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{d.name}</div>
                    <div className="text-[11px] text-faint">
                      {fmtDate(d.createdAt, intlLocale(locale))}
                      {d.size ? ` · ${(d.size / (1024 * 1024)).toFixed(1)}MB` : ""}
                    </div>
                  </div>
                  {/* Estado HONESTO: el conteo real de notas ligadas, no un "destilando…"
                      derivado que miente cuando el turno falló o nunca corrió. */}
                  {d.noteCount > 0 ? (
                    <span className="text-xs tabular-nums shrink-0 text-brand font-semibold">
                      {d.noteCount} {t("notas")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-faint italic">{t("sin notas aún")}</span>
                      <button
                        onClick={() => void retryDoc(d.id)}
                        disabled={ingesting !== null}
                        title={t("Volver a pedir la destilación al agente")}
                        className="inline-flex items-center gap-1 text-xs border border-border rounded-lg px-2 py-1 hover:bg-surface-3 disabled:opacity-50"
                      >
                        <RefreshCw size={12} /> {t("Reintentar")}
                      </button>
                    </span>
                  )}
                  {d.dmId != null ? (
                    <Link
                      to="/c/$slug"
                      params={{ slug: "general" }}
                      search={{ dm: d.dmId } as never}
                      title={t("Ver la conversación donde se destiló")}
                      className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-surface-3 shrink-0"
                    >
                      <MessageSquare size={14} />
                    </Link>
                  ) : null}
                  <button
                    onClick={() => removeDoc(d)}
                    title={t("Quitar de la lista (las notas destiladas se quedan)")}
                    className="p-1.5 rounded-lg text-muted hover:text-red-500 shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {data && (data.rooms.length > 0 || data.channels.length > 0) ? (
          <section className="mt-8">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setRoomsOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink"
              >
                {roomsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {t("Por espacio")} <span className="text-faint font-normal">({data.rooms.length})</span>
              </button>
              {roomsOpen && data.channels.length > 0 && !rule ? (
                <button
                  onClick={() => setRule({ channelId: data.channels[0]!.id, note: "" })}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
                >
                  <Plus size={13} /> {t("Lineamiento")}
                </button>
              ) : null}
            </div>
            {roomsOpen ? (
              <>
                {rule ? (
                  <div className="mt-3 border border-border rounded-xl p-3 flex flex-col gap-2">
                    <select
                      value={rule.channelId}
                      onChange={(e) => setRule({ ...rule, channelId: Number(e.target.value) })}
                      disabled={rule.id != null}
                      className="text-sm bg-transparent border border-border rounded-lg px-2 py-1 self-start"
                    >
                      {data.channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          #{c.slug}
                        </option>
                      ))}
                    </select>
                    <textarea
                      autoFocus
                      value={rule.note}
                      onChange={(e) => setRule({ ...rule, note: e.target.value })}
                      maxLength={data.limits.roomMaxChars}
                      rows={2}
                      placeholder={t("Ej. En este espacio se escribe en registro formal, de usted.")}
                      className="text-sm bg-transparent border border-border rounded-lg px-2 py-1.5 resize-none"
                    />
                    {ruleError ? <p className="text-xs text-red-500">{ruleError}</p> : null}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveRule}
                        disabled={busy || !rule.note.trim()}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-ink text-surface disabled:opacity-40"
                      >
                        {t("Guardar")}
                      </button>
                      <button onClick={() => setRule(null)} className="text-xs text-muted hover:text-ink">
                        {t("Cancelar")}
                      </button>
                      <span className="text-[11px] text-faint ml-auto">
                        {t("Rige para cualquier agente que trabaje en ese espacio.")}
                      </span>
                    </div>
                  </div>
                ) : null}
                {/* Agrupado por espacio, y dentro los LINEAMIENTOS antes que las notas de cada
                    agente: es el orden en el que también llegan al turno. En plano no se veía
                    de quién era cada regla ni a qué room pertenecía. */}
                <ul className="mt-3 flex flex-col gap-4">
                  {[...new Set(data.rooms.map((r) => r.scopeKey))].map((scopeKey) => {
                    const notas = data.rooms.filter((r) => r.scopeKey === scopeKey);
                    const label = notas[0]!.label;
                    const channelId = scopeKey.startsWith("ch:") ? Number(scopeKey.slice(3)) : null;
                    const ordenadas = [
                      ...notas.filter((n) => n.agentHandle === ""),
                      ...notas.filter((n) => n.agentHandle !== ""),
                    ];
                    return (
                      <li key={scopeKey}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-semibold text-muted">{label}</span>
                          {channelId != null && !rule ? (
                            <button
                              onClick={() => setRule({ channelId, note: "" })}
                              title={t("Añadir lineamiento")}
                              className="p-0.5 rounded text-faint hover:text-ink"
                            >
                              <Plus size={13} />
                            </button>
                          ) : null}
                        </div>
                        <ul className="flex flex-col gap-2">
                          {ordenadas.map((n) => {
                            const esRegla = n.agentHandle === "";
                            return (
                              <li
                                key={`${n.scopeKey}-${n.id}`}
                                className="text-sm flex items-start gap-2 border border-border rounded-xl px-3 py-2"
                              >
                                <span className="text-[11px] text-faint shrink-0 mt-0.5 w-28 truncate">
                                  {esRegla ? t("todos los agentes") : `@${n.agentHandle}`}
                                </span>
                                <span className="flex-1 min-w-0 break-words">{n.note}</span>
                                {esRegla && channelId != null ? (
                                  <button
                                    onClick={() => setRule({ id: n.id, channelId, note: n.note })}
                                    title={t("Editar")}
                                    className="p-1 rounded text-muted hover:text-ink shrink-0"
                                  >
                                    <Pencil size={13} />
                                  </button>
                                ) : null}
                                <button
                                  onClick={() => removeRoom(n)}
                                  title={t("Borrar")}
                                  className="p-1 rounded text-muted hover:text-red-500 shrink-0"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="text-[11px] text-faint mt-1">
                {t(
                  "Lineamientos de cada espacio (los sigue cualquier agente) y las convenciones que cada agente guardó por su cuenta."
                )}
              </p>
            )}
          </section>
        ) : null}
      </div>
      {confirming ? (
        <ConfirmModal
          title={confirming.title}
          body={confirming.body}
          confirmLabel={confirming.confirmLabel}
          danger
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            confirming.action();
            setConfirming(null);
          }}
        />
      ) : null}
    </div>
  );
}
