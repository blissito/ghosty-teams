// Riesgo de un PR para quien lo revisa: decide si basta una hojeada o hay que leerlo con calma.
// Por RUTAS y tamaño, sin modelo: es la parte que no se le puede dejar a la palabra de @check.
// @check sólo puede subirlo (nunca bajarlo) y decir qué leer primero.

export type RiskLevel = "low" | "high";
export type RiskReason = "github" | "migration" | "auth" | "deps" | "api" | "size";
export type PrFile = { filename: string; additions?: number; deletions?: number };
export type ReadFirst = { file: string; lines?: string; why?: string };

// Un PR más grande que esto ya no se revisa en 2 minutos, toque lo que toque.
export const BIG_PR_LINES = 400;

const RULES: Array<[RiskReason, RegExp]> = [
  ["github", /^\.github\//],
  ["migration", /(^|\/)(migrations?|prisma)\/|(^|\/)schema[^/]*\.(ts|sql|prisma)$|\.sql$/i],
  ["auth", /(^|[/._-])(auth|session|permissions?|hmac|tokens?|oauth|login|password)([/._-]|$)/i],
  ["deps", /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/],
  ["api", /(^|\/)routes\/api[./]|(^|\/)api\//],
];

export function classifyPrRisk(files: PrFile[]): { level: RiskLevel; reasons: RiskReason[] } {
  const reasons = new Set<RiskReason>();
  let lines = 0;
  for (const f of files) {
    const name = String(f.filename ?? "");
    for (const [reason, re] of RULES) if (re.test(name)) reasons.add(reason);
    lines += Number(f.additions ?? 0) + Number(f.deletions ?? 0);
  }
  if (lines > BIG_PR_LINES) reasons.add("size");
  const list = [...reasons];
  return { level: list.length ? "high" : "low", reasons: list };
}

// Lo que dijo @check, saneado: el nivel sólo sube y «Lee primero» queda en 5 renglones cortos.
export function mergeCheckRisk(
  byPaths: { level: RiskLevel; reasons: RiskReason[] },
  check: { risk?: unknown; readFirst?: unknown },
): { level: RiskLevel; reasons: RiskReason[]; readFirst: ReadFirst[] } {
  const level: RiskLevel = byPaths.level === "high" || check.risk === "high" ? "high" : "low";
  const readFirst = (Array.isArray(check.readFirst) ? check.readFirst : [])
    .filter((r: any) => r && typeof r.file === "string" && r.file.trim())
    .slice(0, 5)
    .map((r: any) => ({
      file: String(r.file).trim().slice(0, 200),
      ...(r.lines ? { lines: String(r.lines).slice(0, 40) } : {}),
      ...(r.why ? { why: String(r.why).slice(0, 200) } : {}),
    }));
  return { level, reasons: byPaths.reasons, readFirst };
}
