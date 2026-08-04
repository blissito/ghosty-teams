// El copy de un formulario nativo, en los idiomas que soporta.
//
// SIN IMPORTS, igual que `form-fields.ts` y por lo mismo: este diccionario lo usa el
// renderer del servidor, el validador del endpoint de submit Y —serializado dentro del
// <script> del formulario— el navegador de quien responde. Cualquier dependencia lo ataría
// a un entorno.
//
// Va por CÓDIGO (`send`, `invalidEmail`) y no por texto-fuente como el `t()` de la app.
// Es lo que permite que servidor y cliente compartan la misma tabla: el script inline
// recibe el objeto ya resuelto y lee `cfg.s.send`, sin diccionario ni fallback dentro.
//
// El idioma de un formulario se fija al CREARLO y se hornea en su HTML. No se puede
// resolver al abrirlo: el HTML se publica como versión de artefacto y quien responde lo ve
// dentro de un iframe de origen opaco, sin cookies y sin sesión.

export type FormLocale = "es" | "en";

export const FORM_LOCALES: FormLocale[] = ["es", "en"];
export const DEFAULT_FORM_LOCALE: FormLocale = "es";

export function isFormLocale(v: unknown): v is FormLocale {
  return v === "es" || v === "en";
}

/** Normaliza cualquier cosa a un idioma válido. Lo que no se reconoce cae al default. */
export function toFormLocale(v: unknown): FormLocale {
  return isFormLocale(v) ? v : DEFAULT_FORM_LOCALE;
}

export type FormStrings = {
  // ── Lo que se hornea en el HTML ──
  thanksDefault: string;
  honeypot: string;
  back: string;
  next: string;
  send: string;
  selectPlaceholder: string;
  yes: string;
  no: string;
  // ── Lo que usa el script del navegador ──
  stepOf: string;
  sending: string;
  uploading: string;
  fileReady: string;
  uploadFailed: string;
  submitFailed: string;
  offline: string;
  // ── Validación: la escriben los dos lados ──
  required: string;
  invalidEmail: string;
  invalidTel: string;
  invalidNumber: string;
  invalidDate: string;
  invalidOption: string;
  invalidAnswer: string;
  matrixIncomplete: string;
  minItems: string;
  maxItems: string;
  // ── Listas repetibles ──
  addItem: string;
  removeItem: string;
  /** Encabezado de cada bloque: "Heredero 2". */
  itemHeading: string;
  /** Nombre por default de un elemento cuando el schema no trae `itemLabel`. */
  itemDefault: string;
  // ── Estado del formulario (las manda el servidor en `errors._form`) ──
  formClosed: string;
  rateLimited: string;
  // ── Interno: lo lee el equipo, no quien responde ──
  anchorMessage: string;
  /** Encabezado de la primera columna de la hoja de respuestas. */
  dateColumn: string;
  // ── La ficha de UNA respuesta ──
  /** Cómo se le llama al documento de una respuesta. */
  fichaLabel: string;
  /** Pie del encabezado de la ficha. */
  fichaAnsweredOn: string;
  /** Encabezado de la columna de respuestas de una matrix dentro de la ficha. */
  fichaAnswerColumn: string;
  /** El mensaje que la anuncia en el hilo. */
  fichaMessage: string;
  fichaMessageAnon: string;
  // ── Guardar y continuar ──
  draftSaving: string;
  draftSaved: string;
  draftTitle: string;
  draftHelp: string;
  draftCopy: string;
  draftCopied: string;
  draftResumed: string;
};

export const FORM_STRINGS: Record<FormLocale, FormStrings> = {
  es: {
    thanksDefault: "¡Gracias! Ya recibimos tus respuestas.",
    honeypot: "No llenar",
    back: "Atrás",
    next: "Siguiente",
    send: "Enviar",
    selectPlaceholder: "Selecciona…",
    yes: "Sí",
    no: "No",
    stepOf: "Paso {n} de {total}",
    sending: "Enviando…",
    uploading: "subiendo…",
    fileReady: "archivo listo",
    uploadFailed: "no se pudo subir el archivo",
    submitFailed: "No se pudo enviar. Inténtalo de nuevo.",
    offline: "Sin conexión. Inténtalo de nuevo.",
    required: "{label} es requerido",
    invalidEmail: "Correo inválido",
    invalidTel: "Teléfono inválido",
    invalidNumber: "Debe ser un número",
    invalidDate: "Fecha inválida (YYYY-MM-DD)",
    invalidOption: "Opción inválida",
    invalidAnswer: "Respuesta inválida",
    matrixIncomplete: "{label}: responde todas las filas",
    minItems: "{label}: agrega al menos {n}",
    maxItems: "{label}: máximo {n}",
    addItem: "Agregar {item}",
    removeItem: "Quitar",
    itemHeading: "{item} {n}",
    itemDefault: "elemento",
    formClosed: "Este formulario ya no recibe respuestas.",
    rateLimited: "Demasiados envíos. Espera un momento.",
    anchorMessage:
      "📋 **{title}** — formulario de intake. Comparte la liga; las respuestas llegan a este hilo.",
    dateColumn: "Fecha",
    fichaLabel: "Ficha",
    fichaAnsweredOn: "_Respondido el {date}_",
    fichaAnswerColumn: "Respuesta",
    fichaMessage: "📄 **Ficha** — {who}",
    fichaMessageAnon: "📄 **Ficha de una respuesta**",
    draftSaving: "Guardando…",
    draftSaved: "Guardado",
    draftTitle: "¿Lo terminas después?",
    draftHelp:
      "Guarda este enlace y ábrelo para seguir donde te quedaste. Caduca en {n} días. Ojo: cualquiera que lo tenga verá lo que llevas escrito.",
    draftCopy: "Copiar enlace",
    draftCopied: "Copiado",
    draftResumed: "Retomamos donde te quedaste.",
  },
  en: {
    thanksDefault: "Thank you! We've received your answers.",
    honeypot: "Do not fill",
    back: "Back",
    next: "Next",
    send: "Submit",
    selectPlaceholder: "Select…",
    yes: "Yes",
    no: "No",
    stepOf: "Step {n} of {total}",
    sending: "Submitting…",
    uploading: "uploading…",
    fileReady: "file ready",
    uploadFailed: "couldn't upload the file",
    submitFailed: "Couldn't submit. Please try again.",
    offline: "You're offline. Please try again.",
    required: "{label} is required",
    invalidEmail: "Invalid email",
    invalidTel: "Invalid phone number",
    invalidNumber: "Must be a number",
    invalidDate: "Invalid date (YYYY-MM-DD)",
    invalidOption: "Invalid option",
    invalidAnswer: "Invalid answer",
    matrixIncomplete: "{label}: please answer every row",
    minItems: "{label}: add at least {n}",
    maxItems: "{label}: {n} at most",
    addItem: "Add {item}",
    removeItem: "Remove",
    itemHeading: "{item} {n}",
    itemDefault: "item",
    formClosed: "This form is no longer accepting responses.",
    rateLimited: "Too many submissions. Please wait a moment.",
    anchorMessage:
      "📋 **{title}** — intake form. Share the link; responses land in this thread.",
    dateColumn: "Date",
    fichaLabel: "Response",
    fichaAnsweredOn: "_Submitted on {date}_",
    fichaAnswerColumn: "Answer",
    fichaMessage: "📄 **Response** — {who}",
    fichaMessageAnon: "📄 **A response came in**",
    draftSaving: "Saving…",
    draftSaved: "Saved",
    draftTitle: "Finishing this later?",
    draftHelp:
      "Save this link and open it to pick up where you left off. It expires in {n} days. Heads up: anyone with it can see what you've filled in.",
    draftCopy: "Copy link",
    draftCopied: "Copied",
    draftResumed: "Picked up where you left off.",
  },
};

export function formStrings(locale: unknown): FormStrings {
  return FORM_STRINGS[toFormLocale(locale)];
}

/** Interpola {placeholders} nombrados. Gemela de la de `i18n.core.ts`, sin importarla. */
export function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  let out = s;
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}
