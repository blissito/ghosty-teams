// El equipo de la fábrica POR REPO y POR PEDIDO — la parte pura (sin red ni base).
//
// Decidido 2026-09-24, mirando a la competencia (Cursor, Factory, Copilot, Devin): la config
// del equipo vive EN EL REPO, versionada, y le gana a la del espacio; y el modelo se cambia
// en el mismo pedido. Precedencia de cada rol:
//
//   mensaje («@build con opus»)  >  .ghosty/factory.md del repo  >  equipo del espacio (/factory)
//
// El archivo del repo:
//
//   ---
//   plan:  { agent: Constructor, model: claude-opus-5 }
//   build:
//     model: claude-sonnet-5
//   check: { agent: OtroGhosty }
//   ---
//   Convenciones que deben saber los tres (tests, estilo, qué no tocar).
//
// `agent` = nombre (o id) de un agente de Studio del espacio. `model` = un modelo del MOTOR de
// ese agente: cambiar de motor es cambiar de caja, y eso se hace con `agent`, no con `model`.
import { FACTORY_HANDLES, type FactoryHandle } from "./factory-roles";

export const TEAM_FILE = ".ghosty/factory.md";

export type RoleSpec = { agent?: string; model?: string };
export type TeamFile = { roles: Partial<Record<FactoryHandle, RoleSpec>>; notes: string };

/** Lo que se pidió EN el mensaje: modelo por rol y, si se nombró, el repo. */
export type TurnOverrides = { models?: Partial<Record<FactoryHandle, string>>; repo?: string };

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();

/** Parser mínimo del frontmatter: `rol: { k: v, k: v }` o `rol:` con `k: v` indentados. */
export function parseTeamFile(raw: string): TeamFile {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { roles: {}, notes: text.trim() };
  const roles: TeamFile["roles"] = {};
  let current: FactoryHandle | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = line.match(/^([a-z]+)\s*:\s*(.*)$/i);
    if (top && !/^\s/.test(line)) {
      const h = top[1].toLowerCase() as FactoryHandle;
      current = (FACTORY_HANDLES as readonly string[]).includes(h) ? h : null;
      if (!current) continue;
      const spec: RoleSpec = (roles[current] ??= {});
      const inline = top[2].trim();
      if (inline.startsWith("{")) {
        for (const pair of inline.replace(/^\{|\}$/g, "").split(",")) {
          const [k, ...v] = pair.split(":");
          assign(spec, k, v.join(":"));
        }
        current = null;
      }
      continue;
    }
    const nested = line.match(/^\s+([a-z]+)\s*:\s*(.+)$/i);
    if (nested && current) assign((roles[current] ??= {}), nested[1], nested[2]);
  }
  return { roles, notes: m[2].trim() };
}

function assign(spec: RoleSpec, key: string, value: string) {
  const k = key.trim().toLowerCase();
  const v = unquote(value ?? "");
  if (!v) return;
  if (k === "agent") spec.agent = v.slice(0, 80);
  if (k === "model") spec.model = v.slice(0, 80);
}

/** Alias cortos por motor, para «@build con opus». El id completo también vale. */
export const MODEL_ALIASES: Record<string, Record<string, string>> = {
  claude: { opus: "claude-opus-5", fable: "claude-fable-5-1", sonnet: "claude-sonnet-5" },
  deepseek: { pro: "deepseek-v4-pro", flash: "deepseek-v4-flash" },
  codex: { sol: "gpt-5.6-sol", terra: "gpt-5.6-terra", luna: "gpt-5.6-luna" },
};

/** Motor al que pertenece un alias o un id conocido (para decir «eso es de otro motor»). */
export function engineOfModel(model: string): string | null {
  const m = model.toLowerCase();
  for (const [engine, aliases] of Object.entries(MODEL_ALIASES)) {
    if (m in aliases || Object.values(aliases).includes(m)) return engine;
  }
  if (m.startsWith("claude-")) return "claude";
  if (m.startsWith("deepseek-")) return "deepseek";
  if (m.startsWith("gpt-")) return "codex";
  return null;
}

/** El id del modelo para ESTE motor, o null si el pedido es de otro motor. */
export function resolveModel(engine: string, asked: string): string | null {
  const m = asked.trim().toLowerCase();
  const aliases = MODEL_ALIASES[engine] ?? {};
  if (aliases[m]) return aliases[m];
  const owner = engineOfModel(m);
  return owner === engine ? m : null;
}

/**
 * Lee del mensaje «@build con opus» y «@plan en agenda» / «en blissito/agenda». El repo sólo
 * cuenta si es uno del room (se compara con el nombre completo o con la parte tras la `/`).
 */
export function parseMessageOverrides(body: string, roomRepos: string[]): TurnOverrides {
  const out: TurnOverrides = {};
  const re = /@(plan|build|check)\b((?:\s+(?:con|en)\s+[\w./-]+){1,2})/gi;
  for (const m of body.matchAll(re)) {
    const h = m[1].toLowerCase() as FactoryHandle;
    for (const part of m[2].matchAll(/\s+(con|en)\s+([\w./-]+)/gi)) {
      const word = part[2].replace(/[.,;:]+$/, "");
      if (part[1].toLowerCase() === "con") {
        if (engineOfModel(word)) (out.models ??= {})[h] = word.toLowerCase();
      } else {
        const repo = roomRepos.find((r) => r.toLowerCase() === word.toLowerCase() || r.split("/")[1]?.toLowerCase() === word.toLowerCase());
        if (repo) out.repo = repo;
      }
    }
  }
  return out;
}

/** Plantilla para «Crear .ghosty/factory.md»: el equipo actual del espacio, listo para editar. */
export function teamFileTemplate(team: Partial<Record<FactoryHandle, { name: string; model: string }>>): string {
  const lines = FACTORY_HANDLES.map((h) => {
    const a = team[h];
    return a ? `${h}: { agent: ${a.name}${a.model ? `, model: ${a.model}` : ""} }` : `# ${h}: { agent: …, model: … }`;
  });
  return (
    `---\n${lines.join("\n")}\n---\n` +
    "Convenciones de este repo que deben saber @plan, @build y @check:\n" +
    "- Cómo se corren las pruebas:\n- Qué no se toca:\n"
  );
}
