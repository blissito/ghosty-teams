// Qué cuida cada check del CI, en una frase para quien decide el merge. Los nombres son de
// cada repo (verify, security, docker…), así que se adivina por patrones; si no se reconoce,
// no se inventa nada y el check va sin frase.
const RULES: { re: RegExp; text: string }[] = [
  { re: /codeql|security|audit|snyk|trivy|semgrep|secret|vuln/i, text: "Busca vulnerabilidades y dependencias con fallas conocidas." },
  { re: /docker|image|container|buildx/i, text: "La imagen de producción se construye: lo que se despliega sí arranca." },
  { re: /e2e|playwright|cypress|smoke/i, text: "Recorre la app como una persona: los flujos principales siguen funcionando." },
  { re: /lint|format|prettier|eslint|biome/i, text: "Estilo y errores comunes del código." },
  { re: /type|tsc/i, text: "Los tipos cuadran: nadie llama a algo que ya no existe." },
  { re: /deploy|preview|vercel|netlify|fly/i, text: "Publica una versión de prueba de esta rama." },
  { re: /test|verify|check|ci\b|unit/i, text: "Corre las pruebas y el typecheck del proyecto." },
  { re: /build|compile/i, text: "El proyecto compila completo." },
];

/** `text` es la llave de i18n (se traduce tal cual); `part` va aparte para no romperla. */
export function explainCheck(name: string): { text: string; part: string | null } | null {
  const rule = RULES.find((r) => r.re.test(name));
  if (!rule) return null;
  // «verify-cli», «test-sdk»: el sufijo dice SOBRE QUÉ parte corre.
  const part = name.match(/[-_:/ ](cli|sdk|api|web|app|server|client|docs|mobile)\b/i)?.[1]?.toLowerCase() ?? null;
  return { text: rule.text, part };
}

/** La frase lista para pintar, con la parte al final: «Corre las pruebas… (cli).» */
export function checkSentence(e: { text: string; part: string | null }, t: (s: string) => string): string {
  const base = t(e.text);
  return e.part ? `${base.replace(/\.$/, "")} (${e.part}).` : base;
}
