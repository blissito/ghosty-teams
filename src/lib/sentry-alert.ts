// Formato de la tarjeta de alerta entrante (Sentry). Vive en `lib/` y no en la ruta
// porque el emisor (webhook, servidor) y el lector (`extractAlert`, navegador) tienen que
// compartir la MISMA forma — igual que `form-fields.ts`. De paso se puede probar sin
// arrastrar el router.

// ── Formato de la tarjeta ────────────────────────────────────────────────────
//
// Lo que se pinta salió de revisar qué formato valora la comunidad (agosto 2026), y el
// hallazgo que más cambió el diseño fue uno NEGATIVO: getsentry/sentry#79095, abierto por
// un mantenedor del propio Sentry, pide poder APAGAR «Suggested Assignees» y «Suspect
// Commit» porque le atribuían errores ajenos por haber sido el último en tocar el archivo.
//
// De ahí la regla de este archivo: **ningún campo inferido**. Sólo entra lo que Sentry
// afirma —cuántas veces pasó, a cuánta gente, en qué ambiente— porque es lo que decide si
// esto se atiende ahora. Un campo que acierta a medias no resta un poco: entrena a la gente
// a ignorar la tarjeta entera, y entonces sobra la alerta completa.

/**
 * El `culprit` viene con el path ABSOLUTO de la máquina que compiló:
 * `Button.props.onPress(/Users/davidzavala/projects/smatch/apps/.../HomeScreen.tsx)`.
 *
 * Impreso tal cual desborda la línea y tapa lo único accionable — que es exactamente lo
 * que pasaba. Aquí se parte en archivo + función y el path **no se imprime nunca**: quien
 * necesite la ruta completa la tiene en Sentry, a un clic.
 */
function splitCulprit(culprit: string): { file: string; fn: string } {
  const c = culprit.trim();
  if (!c) return { file: "", fn: "" };
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

  // `funcion(/ruta/archivo.tsx)` — el formato de los SDK de JS.
  const paren = c.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (paren) return { file: base(paren[2]), fn: lastSegment(paren[1]) };

  // `ruta/archivo.py in funcion` — el de Python y varios más.
  const inWord = c.match(/^(.+?)\s+in\s+(.+)$/);
  if (inWord) return { file: base(inWord[1]), fn: lastSegment(inWord[2]) };

  // Sólo una ruta, o sólo un nombre: si trae separador o extensión es archivo.
  if (/[\\/]/.test(c) || /\.\w{1,5}$/.test(c)) return { file: base(c), fn: "" };
  return { file: "", fn: lastSegment(c) };
}

/** `Button.props.onPress` → `onPress`, pero deja los nombres cortos enteros. */
function lastSegment(fn: string): string {
  const f = fn.trim();
  if (f.length <= 40) return f;
  return f.split(".").pop() || f.slice(-40);
}

/** El valor de un tag del evento (`environment`, `release`…). Sentry los manda de dos formas. */
function tag(p: any, key: string): string {
  const tags = p?.event?.tags;
  if (!Array.isArray(tags)) return "";
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === key) return String(t[1] ?? "");
    if (t && typeof t === "object" && t.key === key) return String(t.value ?? "");
  }
  return "";
}

export type AlertCard = {
  level: string;
  substatus: string;
  title: string;
  project: string;
  file: string;
  fn: string;
  count: number | null;
  users: number | null;
  env: string;
  shortId: string;
  url: string;
  actions: { label: string; send: string }[];
};

/**
 * El payload del webhook legacy es PRIVADO del lado de Sentry (endpoints marcados
 * `ApiPublishStatus.PRIVATE`), así que puede cambiar sin aviso: todo se lee con
 * fallback y nada se asume presente. Lo peor que puede pasar es un mensaje escueto,
 * nunca una excepción que pierda la alerta.
 *
 * `issue` es lo que devolvió `issueForAlert` — o `null`, que es un caso NORMAL, no un
 * error: la tarjeta sale sin conteos y ya.
 *
 * El cuerpo son dos cosas pegadas: el fence `gt-alert` que el cliente pinta como tarjeta,
 * y debajo **una línea de texto plano**. Esa línea es la que ve una cita, el buscador o
 * cualquier cliente que no conozca el fence — sin ella, citar una alerta mostraría JSON.
 */
export function formatAlert(p: any, issue: Record<string, any> | null, handle: string): string {
  const level = String(p?.level ?? p?.event?.level ?? issue?.level ?? "error").toLowerCase();
  const title = String(p?.event?.title ?? p?.message ?? issue?.title ?? p?.culprit ?? "Error en Sentry").slice(0, 300);
  const project = String(p?.project_name ?? p?.project ?? issue?.project?.name ?? "").slice(0, 100);
  const { file, fn } = splitCulprit(String(p?.culprit ?? issue?.culprit ?? "").slice(0, 400));
  const url =
    (typeof p?.url === "string" && p.url) ||
    (typeof p?.event?.web_url === "string" && p.event.web_url) ||
    (typeof issue?.permalink === "string" && issue.permalink) ||
    "";
  const env = String(p?.event?.environment ?? tag(p, "environment") ?? "").slice(0, 40);
  const shortId = String(issue?.shortId ?? "").slice(0, 60);
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Lo que el botón manda es un mensaje NORMAL al canal, y lleva la @mención por eso: la
  // alerta se postea con `postAgent` (mentions_ghosty=0) justo para no despertar al agente
  // en cada error, así que el turno tiene que nacer del clic de una persona, no del webhook.
  //
  // El servidor arma el texto, nunca el cliente: el cliente sólo reenvía un string. Que el
  // navegador redacte lo que el agente va a obedecer es una diferencia de confianza, no de
  // estilo.
  const ref = shortId || title.slice(0, 80);
  const actions: AlertCard["actions"] = [
    { label: "Proponer el fix", send: `@${handle} revisa el error ${ref} en Sentry y propón el fix` },
  ];
  // Silenciar sólo si sabemos QUÉ silenciar: sin shortId el agente tendría que adivinar el
  // issue, y "adivinar" sobre una tool que MODIFICA no es una opción.
  if (shortId) actions.push({ label: "Silenciar", send: `@${handle} silencia el issue ${shortId} en Sentry` });

  const card: AlertCard = {
    level,
    substatus: String(issue?.substatus ?? "").slice(0, 40),
    title,
    project,
    file,
    fn,
    count: num(issue?.count),
    users: num(issue?.userCount),
    env,
    shortId,
    url,
    actions,
  };

  const plain = [shortId, level, title].filter(Boolean).join(" · ");
  return "```gt-alert\n" + JSON.stringify(card) + "\n```\n" + plain;
}
