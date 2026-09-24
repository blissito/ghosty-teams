// Por qué no arrancó una preview, en palabras de persona. Es el patrón de Vercel, Netlify y
// Render cuando falla un deploy: el PASO que falló, la CAUSA probable, QUÉ HACER, y el log
// plegado. El log crudo (con stack traces de V8) solo no le dice nada a quien revisa un PR.
//
// Puro: lo usan la tarjeta (cliente) y los tests. El texto de entrada es el `error` que deja
// `build.sh` en la caja: primera línea = resumen («falló el build (npm run build)»), y lo
// demás = las últimas líneas del log.

export type PreviewStep = "install" | "build" | "start" | "fetch" | "setup";
export type PreviewDiagnosis = {
  step: PreviewStep;
  cause: string;
  hint: string;
  /** El resumen tal cual lo dejó la caja. */
  summary: string;
  /** Log útil: sin el stack nativo de V8 ni líneas vacías repetidas. */
  log: string;
  /** El arreglo está en las Variables de la preview. */
  envRelated: boolean;
};

const RULES: { re: RegExp; cause: string; hint: string; env?: boolean }[] = [
  {
    re: /heap out of memory|Reached heap limit|ENOMEM|Killed\s*$/im,
    cause: "El build se quedó sin memoria",
    hint: "Reintenta: la caja de preview tiene 4 GB. Si vuelve a pasar, el build necesita más de eso.",
  },
  {
    re: /P1001|Can't reach database|ECONNREFUSED|ENOTFOUND .*(mongo|postgres|mysql|redis)|MongoServerSelectionError|getaddrinfo ENOTFOUND/i,
    cause: "La app no alcanza su base de datos",
    hint: "Revisa DATABASE_URL (o la de tu base) en Variables: usa una base de prueba accesible desde internet.",
    env: true,
  },
  {
    re: /(environment variable|env var|process\.env)[^\n]*(missing|not set|required|undefined)|missing required env|is not defined in (the )?env/i,
    cause: "Falta una variable de entorno",
    hint: "Agrega la que falta en Variables (con datos de prueba) y se reintenta sola.",
    env: true,
  },
  {
    re: /ERESOLVE|frozen-lockfile|lockfile.*(outdated|not up to date|needs to be updated)|npm ci can only install/i,
    cause: "Las dependencias no coinciden con el lockfile",
    hint: "Corre la instalación en local y sube el lockfile actualizado en el PR.",
  },
  {
    re: /no contestó en el puerto/i,
    cause: "La app arrancó pero no contesta",
    hint: "La app tiene que escuchar en el puerto de la variable PORT (la preview usa 3000) y en 0.0.0.0.",
  },
  {
    re: /se cayó al arrancar/i,
    cause: "La app se cayó al arrancar",
    hint: "Mira el log: casi siempre es una variable que falta o una base que no alcanza.",
    env: true,
  },
  {
    re: /no sé cómo arrancar|no tiene start, preview ni dev/i,
    cause: "El repo no dice cómo arrancarse",
    hint: "Agrega un script start (o dev) en package.json.",
  },
  {
    re: /no pude bajar el commit/i,
    cause: "No se pudo bajar el código del PR",
    hint: "Revisa que la GitHub App de Ghosty siga instalada en el repo.",
  },
  {
    re: /bun todavía no está soportado/i,
    cause: "Bun todavía no está soportado en las previews",
    hint: "Por ahora las previews usan npm, pnpm o yarn.",
  },
];

function stepOf(summary: string): PreviewStep {
  if (/instalaci[óo]n/i.test(summary)) return "install";
  if (/build/i.test(summary)) return "build";
  if (/arranc|puerto|app/i.test(summary)) return "start";
  if (/bajar el commit/i.test(summary)) return "fetch";
  return "setup";
}

export const STEP_LABEL: Record<PreviewStep, string> = {
  install: "Instalación",
  build: "Build",
  start: "Arranque",
  fetch: "Descarga",
  setup: "Preparación",
};

export function diagnosePreview(error: string | null | undefined): PreviewDiagnosis {
  const text = String(error ?? "").trim();
  const [summary = "", ...rest] = text.split("\n");
  const log = rest
    .filter((l) => !/^\s*\d+:\s+0x[0-9a-f]+/i.test(l)) // stack nativo de V8: ruido
    .filter((l) => !/^\s*<--- (Last few GCs|JS stacktrace) --->\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const rule = RULES.find((r) => r.re.test(text));
  const step = stepOf(summary);
  return {
    step,
    summary: summary.trim(),
    log,
    cause: rule?.cause ?? `Falló ${STEP_LABEL[step].toLowerCase() === "build" ? "el build" : `el paso «${STEP_LABEL[step]}»`}`,
    hint: rule?.hint ?? "Mira el log. Si es el código del PR, @build lo puede corregir; si es configuración, revisa Variables.",
    envRelated: !!rule?.env,
  };
}
