// Automatizaciones de GitHub de un repo en este room: una fila por tipo con su switch.
// Apagadas por default. El agente trabaja a nombre de quien la prende (sus conectores, su bolsa).
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { Toggle } from "./Toggle";
import { AUTOMATION_CATALOG } from "../server/automations/catalog";
import { roomRepoAutomationsFn, setRoomRepoAutomationFn } from "../server/room-repos";

export function RepoAutomations({ channelId, repo }: { channelId: number; repo: string }) {
  const t = useT();
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const apply = (rows: { kind: string; enabled: boolean }[]) => setOn(Object.fromEntries(rows.map((r) => [r.kind, r.enabled])));

  useEffect(() => {
    setOn(null);
    setErr("");
    roomRepoAutomationsFn({ data: { channelId, repo } })
      .then(apply)
      .catch(() => setOn({}));
  }, [channelId, repo]);

  const toggle = async (kind: string, enabled: boolean) => {
    setBusy(kind);
    setErr("");
    try {
      apply(await setRoomRepoAutomationFn({ data: { channelId, repo, kind, enabled } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <p className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">{t("Automatizaciones")}</p>
      {AUTOMATION_CATALOG.map((a) => (
        <div key={a.kind} className="flex items-start gap-2 px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{t(a.name)}</p>
            <p className="text-[11px] leading-snug text-muted">{t(a.line)}</p>
          </div>
          <Toggle on={on?.[a.kind] === true} disabled={on === null || busy !== null} onChange={(v) => toggle(a.kind, v)} label={t(a.name)} />
        </div>
      ))}
      <p className="px-3 pb-2 pt-1 text-[11px] leading-snug text-muted">
        {t("Cada automatización trabaja en su propio hilo de este room, a nombre de quien la prende. Nunca mezcla ni cierra nada.")}
      </p>
      {err && <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">{err}</p>}
    </div>
  );
}
