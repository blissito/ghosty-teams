// ── Automatizaciones de GitHub por room: el contrato ─────────────────────────────────────────
//
// gs normaliza cada entrega del webhook de la App a `RepoEvent` (`app/lib/github/app-hook.server.ts`
// en ghosty-studio: mantener los dos tipos iguales) y la reparte a `api/internal/github-event`.
// Ahí `dispatchRepoEvent` busca los rooms que tienen el repo, las automatizaciones que ese room
// prendió (`gt_repo_automations`) y les pasa el evento con un `AutomationCtx`.

export type AutomationKind =
  | "ci_fix"          // CI rojo en un PR cualquiera → arreglar en su rama
  | "dep_fix"         // PR de dependabot[bot]/renovate[bot] con CI rojo → arreglar
  | "pr_to_green"     // PR en conflicto (mergeable_state dirty) → actualizar/resolver
  | "pr_review"       // PR humano abierto/listo → @check revisa, sólo P0/P1
  | "review_autofix"  // comentario de review de una persona → corregir y contestar el hilo
  | "security_fix"    // alertas code scanning / dependabot → PR con arreglos en lote
  | "maintenance"     // turno programado por repo (deps, docs, TODOs) → issue o PR borrador
  | "issue_triage"    // issue abierto → etiquetas, duplicados, pedir repro
  | "ci_doctor";      // falla de CI → diagnóstico; flaky (falló y pasó con el mismo sha) → issue agrupado

/** Lo que gs reenvía (normalizado, sin secretos). Campos opcionales según el evento. */
export type RepoEvent = {
  deliveryId: string;
  event: string;            // nombre del header X-GitHub-Event
  action?: string;
  repo: string;             // "owner/name"
  sender?: { login: string; type?: string };   // type "Bot" para bots
  pr?: { number: number; title?: string; author?: string; authorType?: string; draft?: boolean;
         base?: string; head?: string; headSha?: string; mergeableState?: string; url?: string;
         /** "owner/name" del repo de la rama (`head` es sólo el nombre de la rama). */
         headRepo?: string;
         /** La rama del PR vive en otro repo (`headRepo` ≠ `repo`): la App no puede empujar ahí. */
         fork?: boolean };
  issue?: { number: number; title?: string; body?: string; labels?: string[]; author?: string; url?: string };
  review?: { id?: number; state?: string; body?: string; author?: string };
  comment?: { id: number; body?: string; path?: string; line?: number; author?: string; inReplyTo?: number; url?: string };
  thread?: { nodeId?: string; resolved?: boolean };
  run?: { id: number; name?: string; conclusion?: string | null; headSha?: string; headBranch?: string;
          attempt?: number; event?: string; prNumbers?: number[]; url?: string };
  alert?: { kind: "code_scanning" | "dependabot" | "secret_scanning"; number: number; severity?: string;
            rule?: string; package?: string; state?: string; url?: string };   // secret scanning: NUNCA el secreto
};

export type AutomationCtx = {
  ns: string;               // namespace del workspace de Teams
  roomId: string;           // room que tiene ligado el repo
  repo: string;
  /** Turno de un agente del room en un hilo propio de la automatización (lo implementa EVENTOS
   *  reutilizando el mecanismo de wakeups/relevo existente). `handle` p. ej. "build", "check", "plan". */
  wake(opts: { handle: string; text: string; threadKey: string; title?: string;
    /** Segundos antes de abrir el turno (juntar alertas en una ventana). Durable: sobrevive reinicios. */
    delayS?: number }): Promise<void>;
  /** Aviso en el room SIN abrir turno (secreto filtrado, se agotaron los intentos…). Con `threadKey`
   *  va en el hilo de esa clave (lo crea con `title` si no existe); sin ella, suelto en el room. */
  post(text: string, opts?: { threadKey?: string; title?: string; handle?: string }): Promise<void>;
  /** Dedupe/anti-bucle: true sólo la 1.ª vez para (ns, kind, key) dentro de `ttlMs`. */
  claim(kind: AutomationKind, key: string, ttlMs?: number): Promise<boolean>;
  /** Tope diario por repo y tipo (default 20). false = no correr. */
  budget(kind: AutomationKind): Promise<boolean>;
  /** Ajustes de la automatización para ese room+repo (JSON libre por tipo, p. ej. severidad mínima). */
  settings<T = Record<string, unknown>>(kind: AutomationKind): Promise<T>;
};

export type Automation = {
  kind: AutomationKind;
  /** Eventos (`event` o `event.action`) que le interesan. */
  on: string[];
  handle(ev: RepoEvent, ctx: AutomationCtx): Promise<void>;
  /** El despachador tira los eventos que causó nuestro bot (anti-bucle). `true` = esta
   *  automatización sí los quiere ver (p. ej. un CI rojo sobre un commit que empujó Ghosty). */
  allowGhostyBot?: boolean;
};
