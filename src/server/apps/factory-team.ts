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

// Base de conocimiento del repo: fichas cortas en el PROPIO repo (versionadas, revisadas por PR
// y legibles por cualquier arnés), con `AGENTS.md` como índice. La fábrica no guarda índice
// propio: sólo le dice a cada rol qué fichas hay.
export const KNOWLEDGE_DIR = "docs/agents";

/** Renglón de contexto con las fichas del repo (o cómo empezar si aún no hay). */
export function knowledgeLine(repo: string, files: string[]): string {
  if (!files.length)
    return `Base de conocimiento de ${repo}: todavía no hay fichas en ${KNOWLEDGE_DIR}/. La primera la escribe @build cuando un cambio fije una convención o descubra una trampa.`;
  const list = files.slice(0, 40).map((f) => `${KNOWLEDGE_DIR}/${f}`).join(", ");
  return `Base de conocimiento de ${repo} (${KNOWLEDGE_DIR}/, índice en AGENTS.md; léela con github_read_file ANTES de tocar el tema y le gana a tu intuición): ${list}${files.length > 40 ? ` y ${files.length - 40} más` : ""}.`;
}

export type RoleSpec = { agent?: string; model?: string };

/** Servicios que la caja de trabajo `dev` trae instalados y apagados. */
export const SETUP_SERVICES = ["postgres", "redis"] as const;
export type SetupService = (typeof SETUP_SERVICES)[number];

/**
 * El entorno de pruebas del repo (`setup:` en el frontmatter de `.ghosty/factory.md`). @build y
 * @check lo aplican con `prepare(box.id, setup)` del SDK: servicios arriba, base de prueba LIMPIA,
 * variables de prueba y el script del repo. Nació del #13 de mercadito-verde (6-oct): @build pasó
 * ~50 min instalando Postgres a mano y adivinando los secretos de prueba que ya estaban en el CI.
 */
export type RepoSetup = {
  services: SetupService[];
  /** Nombre de la base y de su usuario (contraseña = nombre). Default `app`. */
  db?: string;
  /** Variables de PRUEBA (las del CI), nunca secretos reales: van al `.env.test` de la caja. */
  env: Record<string, string>;
  /** Script del repo que deja todo listo (migraciones, semillas), relativo a la raíz. */
  script?: string;
};

export type TeamFile = {
  roles: Partial<Record<FactoryHandle, RoleSpec>>;
  setup?: RepoSetup;
  notes: string;
  /** Lo que va bajo `## @plan`, `## @build` o `## @check` en el cuerpo: sólo para ese rol. */
  roleNotes: Partial<Record<FactoryHandle, string>>;
};

/** Lo que se pidió EN el mensaje: modelo por rol y, si se nombró, el repo. */
export type TurnOverrides = {
  models?: Partial<Record<FactoryHandle, string>>;
  /** Agente de Studio por rol (nombre o id). Hoy sólo lo fija un eval, no el mensaje. */
  agents?: Partial<Record<FactoryHandle, string>>;
  repo?: string;
};

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();

/** Parser mínimo del frontmatter: `rol: { k: v, k: v }` o `rol:` con `k: v` indentados. */
export function parseTeamFile(raw: string): TeamFile {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { roles: {}, ...splitRoleNotes(text) };
  const roles: TeamFile["roles"] = {};
  let current: FactoryHandle | null = null;
  // `setup:` es otro bloque (con lista y un mapa anidado): sus renglones se juntan aparte.
  let inSetup = false;
  const setupLines: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (inSetup && /^\s/.test(line)) {
      setupLines.push(line);
      continue;
    }
    inSetup = false;
    const top = line.match(/^([a-z]+)\s*:\s*(.*)$/i);
    if (top && !/^\s/.test(line) && top[1].toLowerCase() === "setup") {
      inSetup = true;
      current = null;
      continue;
    }
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
  const setup = setupLines.length ? parseSetup(setupLines) : undefined;
  return { roles, ...(setup ? { setup } : {}), ...splitRoleNotes(m[2]) };
}

const SAFE_DB = /^[a-z_][a-z0-9_]{0,40}$/i;
const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SAFE_SCRIPT = /^[\w./-]{1,120}$/;

/**
 * El bloque `setup:` (renglones ya indentados):
 *
 *   setup:
 *     services: [postgres, redis]     # o «postgres, redis»
 *     db: fruteria
 *     script: .ghosty/setup.sh
 *     env:
 *       JWT_SECRET: test-jwt-secret
 *
 * Lo que no se entiende se ignora (un servicio que la caja no trae, un nombre raro): nunca rompe
 * la lectura del resto del archivo. Devuelve undefined si no queda nada útil.
 */
export function parseSetup(lines: string[]): RepoSetup | undefined {
  const out: RepoSetup = { services: [], env: {} };
  const baseIndent = Math.min(...lines.map((l) => l.match(/^\s*/)![0].length));
  let inEnv = false;
  for (const line of lines) {
    const indent = line.match(/^\s*/)![0].length;
    const kv = line.trim().match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, rawKey, rawVal] = kv;
    if (inEnv && indent > baseIndent) {
      const v = unquote(rawVal.replace(/\s+#.*$/, ""));
      if (SAFE_ENV_KEY.test(rawKey) && Object.keys(out.env).length < 40) out.env[rawKey] = v.slice(0, 500);
      continue;
    }
    inEnv = false;
    const key = rawKey.toLowerCase();
    const val = rawVal.replace(/\s+#.*$/, "").trim();
    if (key === "env") {
      inEnv = true;
      continue;
    }
    if (key === "services") {
      out.services = val
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => unquote(s).toLowerCase().replace(/@.*$/, ""))
        .filter((s): s is SetupService => (SETUP_SERVICES as readonly string[]).includes(s));
      out.services = [...new Set(out.services)];
    } else if (key === "db") {
      const v = unquote(val);
      if (SAFE_DB.test(v)) out.db = v;
    } else if (key === "script") {
      const v = unquote(val).replace(/^\.\//, "");
      if (SAFE_SCRIPT.test(v) && !v.includes("..")) out.script = v;
    }
  }
  return out.services.length || out.db || out.script || Object.keys(out.env).length ? out : undefined;
}

/** La línea de contexto para @build y @check: la llamada exacta que prepara la caja de trabajo. */
export function setupLine(repo: string, setup: RepoSetup): string {
  const call = `await prepare(box.id, ${JSON.stringify(setup)})`;
  return (
    `Entorno de pruebas de ${repo} (setup: de .ghosty/factory.md): en la caja de trabajo, después del checkout en /app/repo, corre TAL CUAL ` +
    `\`${call}\` (import { prepare } from "/opt/gs-sdk/sandbox.mjs"). Arranca ${setup.services.join(" y ") || "lo declarado"}, deja la base de prueba vacía, ` +
    `escribe /app/repo/.env.test con las variables de prueba y corre el script del repo. Vuelve a llamarla antes de cada corrida de la suite. ` +
    `No instales servicios con apt ni inventes variables: si falta algo, dilo y propón el cambio a setup:.`
  );
}

/**
 * Parte el cuerpo por encabezados `## @rol`: cada sección va sólo a ese rol (las reglas de
 * revisión que @check debe aplicar en ESTE repo, como el `BUGBOT.md` de Cursor) y el resto son
 * las convenciones de los tres. Una sección termina en el siguiente `## `.
 */
function splitRoleNotes(body: string): Pick<TeamFile, "notes" | "roleNotes"> {
  const roleNotes: TeamFile["roleNotes"] = {};
  const common: string[] = [];
  let current: FactoryHandle | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+@?([a-z]+)\s*$/i);
    if (h2) {
      const h = h2[1].toLowerCase();
      current = (FACTORY_HANDLES as readonly string[]).includes(h) ? (h as FactoryHandle) : null;
      if (current) continue;
    } else if (/^##\s/.test(line)) current = null;
    if (current) roleNotes[current] = `${roleNotes[current] ?? ""}${line}\n`;
    else common.push(line);
  }
  for (const h of Object.keys(roleNotes) as FactoryHandle[]) {
    const t = roleNotes[h]!.trim();
    if (t) roleNotes[h] = t;
    else delete roleNotes[h];
  }
  return { notes: common.join("\n").trim(), roleNotes };
}

function assign(spec: RoleSpec, key: string, value: string) {
  const k = key.trim().toLowerCase();
  const v = unquote(value ?? "");
  if (!v) return;
  if (k === "agent") spec.agent = v.slice(0, 80);
  if (k === "model") spec.model = v.slice(0, 80);
}

/** Alias cortos por motor, para «@build con opus». El id completo también vale. */
/**
 * Modelo de casa por rol cuando nadie pide otro (ni el mensaje ni `.ghosty/factory.md`). @plan
 * diagnostica el estado entero de la fábrica y decide qué reparar: va en el modelo más fuerte
 * aunque su agente de Studio corra en otro (decisión de bliss, 4-oct). Sólo si el motor es ése.
 */
export const ROLE_DEFAULT_MODEL: Partial<Record<string, { engine: string; model: string }>> = {
  plan: { engine: "claude", model: "claude-opus-5-5" },
  // @check es la última puerta antes del merge: mismo modelo que @plan (decisión de bliss, 5-oct).
  check: { engine: "claude", model: "claude-opus-5-5" },
};

export const MODEL_ALIASES: Record<string, Record<string, string>> = {
  // Todas las opciones del catálogo de Studio (engines.ts), sin quitar ninguna: el alias corto
  // es la versión de siempre y la versión explícita elige otra («con opus-5.5», «con opus-4.8»).
  claude: {
    opus: "claude-opus-5",
    "opus-5": "claude-opus-5",
    "opus-5.5": "claude-opus-5-5",
    "opus-4.8": "claude-opus-4-8",
    fable: "claude-fable-5-1",
    "fable-5.1": "claude-fable-5-1",
    "fable-5": "claude-fable-5",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "sonnet-4.6": "claude-sonnet-4-6",
  },
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
    `---\n${lines.join("\n")}\n` +
    "# setup:                          # entorno de pruebas de la caja de trabajo (ver /docs/fabrica/equipo-por-repo)\n" +
    "#   services: [postgres, redis]\n#   db: app\n#   env:\n#     JWT_SECRET: test-secret\n" +
    "---\n" +
    "Convenciones de este repo que deben saber @plan, @build y @check:\n" +
    "- Cómo se corren las pruebas:\n- Qué no se toca:\n"
  );
}
