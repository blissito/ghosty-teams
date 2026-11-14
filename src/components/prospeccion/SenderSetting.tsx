import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Mail, MessageCircle, MousePointerClick, RefreshCw } from "lucide-react";
import { useT } from "../../i18n";
import { getProspCtaFn, getProspSenderFn, getProspWaFn, setProspCtaFn, setProspSenderFn, setProspWaFn } from "../../server/prospeccion";
import { prettyWaPhone } from "../../lib/prospeccion-wa-phone";

type Sender = NonNullable<Awaited<ReturnType<typeof getProspSenderFn>>>;

/**
 * De quién sale el correo.
 *
 * Va junto al WhatsApp y por la misma razón: sin remitente propio el prospecto recibe un
 * correo de `noreply@ghosty.studio` y contesta a nadie. Con el dominio del usuario, la
 * respuesta cae en SU buzón — y ahí es donde empieza la venta.
 *
 * El dominio se verifica en SES con 3 CNAME (Easy DKIM). Hasta que resuelven, el envío
 * sigue saliendo del de casa y aquí se dice, con los registros a la vista para copiarlos.
 */
export function SenderSetting({ listId, onSaved }: { listId?: number; onSaved?: () => void } = {}) {
  const t = useT();
  const [s, setS] = useState<Sender | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => getProspSenderFn({ data: { listId } }).then((r) => { if (r) setS(r); }).catch(() => {});
  useEffect(() => { void load(); }, [listId]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await setProspSenderFn({ data: { email, name, listId } }).catch(() => ({ error: t("No se pudo guardar") }));
    setBusy(false);
    if ("error" in r && r.error && !("email" in r)) { setError(r.error); return; }
    setS(r as Sender);
    setEditing(false);
    onSaved?.();
  };

  const check = async () => {
    setBusy(true);
    await load();
    setBusy(false);
  };

  const copy = (v: string) => {
    navigator.clipboard?.writeText(v).catch(() => {});
    setCopied(v);
    setTimeout(() => setCopied(null), 1200);
  };

  if (!s) return null;

  return (
    <div className="mt-1.5 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <Mail size={13} className="text-muted shrink-0" />
        {editing ? (
          <>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Tu nombre o el de tu empresa")}
              onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
              className="w-44 bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("tu@tudominio.com")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-52 bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand"
            />
            <button onClick={() => void save()} disabled={busy} className="font-medium text-brand disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : t("Guardar")}
            </button>
            <button onClick={() => setEditing(false)} className="text-muted hover:text-ink">{t("Cancelar")}</button>
          </>
        ) : (
          <button
            onClick={() => { setName(s.name); setEmail(s.email); setEditing(true); }}
            className="text-muted hover:text-ink text-left"
          >
            {s.status === "verified" ? (
              <>
                {t("Sale de")} <span className="text-ink font-medium">{s.effectiveFrom}</span>
              </>
            ) : s.email ? (
              <>
                {t("Sale de")} <span className="text-ink font-medium">{s.effectiveFrom}</span>{" "}
                <span className="text-amber-700 dark:text-amber-300">
                  {t("hasta que")} {s.domain} {t("esté verificado")}
                </span>
              </>
            ) : (
              <>
                {t("Sale de")} <span className="text-ink font-medium">{s.effectiveFrom}</span>{" "}
                <span className="text-brand underline underline-offset-2">{t("· usar mi dominio")}</span>
              </>
            )}
          </button>
        )}
        {error ? <span className="text-red-500">{error}</span> : null}
      </div>

      {/* Los CNAME, sólo mientras falten: cuando el dominio ya pasó no hay nada que hacer. */}
      {!editing && s.domain && s.status !== "verified" ? (
        <div className="mt-2 ml-5 rounded-lg border border-border bg-surface-2 p-3 max-w-xl">
          {s.status === "none" && s.error ? (
            <p className="text-muted">{t("No pude pedir la verificación a SES:")} {s.error}</p>
          ) : (
            <>
              <p className="mb-2">
                {s.status === "failed"
                  ? t("La verificación falló. Revisa que los 3 registros estén tal cual y vuelve a comprobar.")
                  : t("Pon estos 3 registros CNAME en el DNS de")}{" "}
                {s.status !== "failed" ? <span className="font-medium">{s.domain}</span> : null}
                {s.status !== "failed" ? t(". Tardan de minutos a unas horas en verse.") : null}
              </p>
              <table className="w-full text-[11px] font-mono">
                <tbody>
                  {s.dns.map((r) => (
                    <tr key={r.name} className="align-top">
                      <td className="pr-2 py-0.5 break-all">
                        <button onClick={() => copy(r.name)} title={t("Copiar")} className="inline-flex items-center gap-1 hover:text-brand text-left">
                          {copied === r.name ? <Check size={10} /> : <Copy size={10} />} {r.name}
                        </button>
                      </td>
                      <td className="text-muted pr-2 py-0.5">CNAME</td>
                      <td className="py-0.5 break-all">
                        <button onClick={() => copy(r.value)} title={t("Copiar")} className="inline-flex items-center gap-1 hover:text-brand text-left">
                          {copied === r.value ? <Check size={10} /> : <Copy size={10} />} {r.value}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-muted">
                {t("No cambies tu MX: sigues recibiendo donde siempre. Si tu SPF termina en -all, añádele")}{" "}
                <code>include:amazonses.com</code>.
              </p>
              <button onClick={() => void check()} disabled={busy} className="mt-2 inline-flex items-center gap-1 font-medium text-brand disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {t("Comprobar")}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

type Cta = NonNullable<Awaited<ReturnType<typeof getProspCtaFn>>>;

/**
 * Con qué cierra el correo. Una sola cosa que pedir, decidida una vez por workspace: el
 * agente la conoce al redactar y no inventa otra, y la plantilla la pinta al final.
 */
export function CtaSetting({ listId, onSaved }: { listId?: number; onSaved?: () => void } = {}) {
  const t = useT();
  const [c, setC] = useState<Cta | null>(null);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<Cta["kind"]>("wa");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [waText, setWaText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getProspCtaFn({ data: { listId } }).then((r) => { if (r) setC(r); }).catch(() => {}); }, [listId]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await setProspCtaFn({ data: { kind, label, url, listId, ...(kind === "wa" ? { waText } : {}) } }).catch(() => ({ error: t("No se pudo guardar") }));
    setBusy(false);
    if ("error" in r && r.error) { setError(r.error); return; }
    setC(r as Cta);
    setEditing(false);
    onSaved?.();
  };

  if (!c) return null;
  const KINDS: { id: Cta["kind"]; label: string }[] = [
    { id: "wa", label: t("Botón a mi WhatsApp") },
    { id: "reply", label: t("Que me responda el correo") },
    { id: "link", label: t("Botón a un enlace") },
  ];

  return (
    <div className="mt-1.5 text-xs flex items-center gap-2 flex-wrap">
      <MousePointerClick size={13} className="text-muted shrink-0" />
      {editing ? (
        <>
          <select value={kind} onChange={(e) => setKind(e.target.value as Cta["kind"])} className="bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand">
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={kind === "reply" ? t("Si te interesa, responde y te cuento más.") : t("Texto del botón")}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            className="w-64 bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand"
          />
          {kind === "link" ? (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
              className="w-56 bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand"
            />
          ) : null}
          {kind === "wa" ? (
            // Lo que llega escrito al abrir el chat: es lo que le dice al agente de qué campaña viene.
            <input
              value={waText}
              onChange={(e) => setWaText(e.target.value)}
              placeholder={t("Mensaje que llega escrito: Hola, me llegó su correo (soy de {negocio}).")}
              title={t("{negocio} se cambia por el nombre de cada fila")}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
              className="w-80 bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand"
            />
          ) : null}
          <button onClick={() => void save()} disabled={busy} className="font-medium text-brand disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : t("Guardar")}
          </button>
          <button onClick={() => setEditing(false)} className="text-muted hover:text-ink">{t("Cancelar")}</button>
        </>
      ) : (
        <button
          onClick={() => { setKind(c.kind); setLabel(c.label); setUrl(c.url); setWaText(c.waText); setEditing(true); }}
          className="text-muted hover:text-ink text-left"
        >
          {t("El correo cierra con")}{" "}
          <span className="text-ink font-medium">
            {c.kind === "wa" ? t("botón a WhatsApp") : c.kind === "link" ? t("botón a") + " " + c.url : t("«") + c.label + t("»")}
          </span>
        </button>
      )}
      {error ? <span className="text-red-500">{error}</span> : null}
    </div>
  );
}

/**
 * El WhatsApp al que escriben, de la CAMPAÑA (con `listId`) o el del espacio por defecto.
 * Es el número del botón del correo: dos campañas a la vez ya no se pisan el número.
 */
export function WaSetting({ listId, onSaved }: { listId?: number; onSaved?: () => void } = {}) {
  const t = useT();
  const [phone, setPhone] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { getProspWaFn({ data: { listId } }).then((r) => setPhone(r.phone)).catch(() => setPhone("")); }, [listId]);

  const save = async (valor: string) => {
    const r = await setProspWaFn({ data: { phone: valor, listId } }).catch(() => ({ ok: false as const, phone: "", error: "" }));
    if (!r.ok) { setError(("error" in r && r.error) || t("No parece un número de WhatsApp")); return; }
    setPhone(r.phone);
    setError(null);
    setEditing(false);
    onSaved?.();
  };

  if (phone === null) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 text-xs">
      <MessageCircle size={13} className="text-muted shrink-0" />
      {editing ? (
        <input
          autoFocus
          defaultValue={phone}
          placeholder={t("771 446 0521")}
          onBlur={(e) => save(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save(e.currentTarget.value);
            if (e.key === "Escape") { setEditing(false); setError(null); }
          }}
          className="w-44 bg-surface-2 border border-border rounded-lg px-2 py-1 outline-none focus:border-brand"
        />
      ) : (
        <button onClick={() => setEditing(true)} className="text-muted hover:text-ink">
          {phone ? (
            <>{t("Te escriben al")} <span className="text-ink font-medium">{prettyWaPhone(phone)}</span></>
          ) : (
            <span className="text-brand underline underline-offset-2">{t("Pon el WhatsApp al que quieres que te escriban")}</span>
          )}
        </button>
      )}
      {error ? <span className="text-red-500">{error}</span> : null}
    </div>
  );
}
