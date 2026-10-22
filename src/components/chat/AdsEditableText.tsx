// El texto que se edita con un clic en las tarjetas de Ghosty Ads (Meta y Google): textarea
// con [Guardar] [Cancelar]. Vive aparte para que la tarjeta de Google lo use sin importar la de Meta.
import { useState } from "react";
import { useT } from "../../i18n";

export const adsBtn = "rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50";
const btn = adsBtn;

/** Texto que se edita con un clic: textarea (o input) con [Guardar] [Cancelar]. */
export function EditableText({
  value,
  editable,
  label,
  className,
  onSave,
  multiline,
  inline,
  placeholder,
}: {
  value: string;
  editable: boolean;
  label: string;
  className?: string;
  onSave: (v: string) => Promise<void>;
  multiline?: boolean;
  inline?: boolean;
  placeholder?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  if (editing) {
    return (
      <span className={`${inline ? "inline-flex" : "flex"} w-full flex-col gap-1`}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={multiline ? 4 : 1}
          aria-label={label}
          autoFocus
          className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink"
        />
        <span className="flex gap-1.5">
          <button
            type="button"
            disabled={saving || draft.trim() === value.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(draft.trim());
                setEditing(false);
              } catch {
                /* el error lo enseña la tarjeta; el editor sigue abierto */
              } finally {
                setSaving(false);
              }
            }}
            className={`${btn} border-brand text-brand hover:bg-brand/10`}
          >
            {saving ? t("Guardando…") : t("Guardar")}
          </button>
          <button type="button" disabled={saving} onClick={() => setEditing(false)} className="px-1 text-xs text-muted hover:text-ink">
            {t("Cancelar")}
          </button>
        </span>
      </span>
    );
  }
  if (!editable) return value ? <span className={`${inline ? "" : "block"} ${className ?? ""}`}>{value}</span> : null;
  return (
    <button
      type="button"
      title={t("Clic para editar")}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={`${inline ? "inline" : "block w-full"} cursor-text rounded text-left decoration-dotted underline-offset-2 hover:underline ${value ? (className ?? "") : "text-xs text-muted"}`}
    >
      {value || placeholder}
    </button>
  );
}
