// Qué tan grande es un PR de Dependabot, leído de su título. Lo usa la fábrica para decidir si
// entra solo (patch/minor con el CI en verde) o espera a una persona (major).
//   «Bump motion from 12.43.0 to 14.0.0»                       → major
//   «Bump @types/node from 22.20.5 to 26.6.4 in /cli»          → major
//   «Bump the minor-and-patch group with 7 updates»            → minor (el grupo lo dice)
//   «Bump the npm_and_yarn group across 2 directories with 3 updates» → unknown
export type BumpLevel = "major" | "minor" | "patch" | "unknown";

export function isDependabot(author: string | null | undefined): boolean {
  return /^dependabot(\[bot\])?$/i.test(String(author ?? ""));
}

const parts = (v: string) => v.replace(/^v/i, "").split(/[.-]/).map((n) => Number.parseInt(n, 10));

export function bumpLevel(title: string): BumpLevel {
  const m = title.match(/\bfrom\s+v?(\d[\w.-]*)\s+to\s+v?(\d[\w.-]*)/i);
  if (m) {
    const [a, b] = [parts(m[1]), parts(m[2])];
    if (a.some(Number.isNaN) || b.some(Number.isNaN)) return "unknown";
    // En 0.x el «minor» rompe como un major (semver §4).
    if (b[0] !== a[0]) return "major";
    if (a[0] === 0 && b[1] !== a[1]) return "major";
    if (b[1] !== a[1]) return "minor";
    return "patch";
  }
  const g = title.match(/\bthe\s+([\w-]+)\s+group\b/i)?.[1]?.toLowerCase() ?? "";
  if (g && !g.includes("major") && /minor|patch/.test(g)) return g.includes("minor") ? "minor" : "patch";
  return "unknown";
}

/** Entra solo con el automerge del room: sólo lo que semver promete que no rompe. */
export function autoMergeable(level: BumpLevel): boolean {
  return level === "minor" || level === "patch";
}
