// Registro central de conectores (el "estandarizar"). Agregar un conector = UNA entrada
// aquí (+ su MCP en Fase B para que @ghosty lo use). El cliente OAuth, las rutas
// (setup.$provider.*) y el panel de Integraciones son 100% data-driven sobre esto: NO se
// copian archivos por proveedor (a diferencia del molde bespoke de Studio).
//
// Modelo Cowork / per-user: cada usuario conecta SU cuenta; el token vive en
// gc_user_connectors keyed por (user_sub, provider). Ver connectors/store.server.ts.

export type ConnectorStatus = "available" | "soon";

export type ConnectorDef = {
  id: string; // slug URL-safe; = segmento de /setup/<id>/connect
  name: string;
  blurb: string;
  icon: string; // clave → el panel la mapea a SVG/lucide (client)
  type: string; // columna "Tipo" estilo claude.ai (hoy siempre "Web")
  custom?: boolean; // badge "Personalizado"
  status: ConnectorStatus;
  // Enlace externo que se ofrece CUANDO YA está conectado, para administrar el
  // alcance del lado del proveedor. Existe por GitHub: conectar no basta, hay
  // que elegir a qué repositorios llega la app, y eso se cambia después sin
  // reconectar. Sin este botón el usuario no tiene forma de descubrirlo.
  manage?: { url: string; label: string };
  oauth?: {
    authUrl: string;
    tokenUrl: string;
    scopes?: string; // omitido si el provider no usa scopes (Calendly)
    pkce?: boolean;
    clientIdEnv: string;
    clientSecretEnv: string;
    // Headers extra en el POST al token endpoint. GitHub lo necesita: sin
    // `Accept: application/json` responde form-encoded y el `res.json()` del
    // cliente genérico revienta. Nadie más lo usa.
    tokenHeaders?: Record<string, string>;
    // No mandar `redirect_uri` — ni al autorizar ni al canjear. GitHub lo exige
    // así en el flujo de instalación: `/apps/<slug>/installations/new` NO acepta
    // el parámetro, así que el `code` queda ligado a la Callback URL registrada
    // y mandarlo después en el exchange da `redirect_uri_mismatch`. La regla de
    // GitHub es simétrica: si no fue en el authorize, no va en el exchange.
    noRedirectUri?: boolean;
    userInfoUrl?: string; // tras conectar: captura external_id + meta
    // Traduce la respuesta del userInfoUrl a lo que se persiste. Cada proveedor
    // devuelve una forma distinta; sin esto el parser de UNO quedaba escrito a
    // mano dentro de finishConnectFn y los demás se quedaban sin meta.
    parseUserInfo?: (json: any) => { externalId: string | null; meta: unknown };
    // Cada cuánto releer el userinfo para refrescar `meta` (default 15 min).
    // Ver connectors/meta.server.ts.
    metaTtlS?: number;
    // RFC 7009. Al desconectar, borrar la fila local sólo deja de USAR el token:
    // sigue vivo del lado del proveedor hasta que expire. Con esto se revoca de
    // verdad — indispensable cuando el token concede lectura cross-tenant.
    revokeUrl?: string;
  };
};

// Base de la API de Deník. Override por env para apuntar a una instancia local
// (el flujo OAuth completo se puede ejercitar sin dominio público).
const DENIK_BASE = (process.env.DENIK_BASE_URL ?? "https://www.denik.me").replace(/\/$/, "");

// Base de Sentry. Override por env para self-hosted o la región EU (https://de.sentry.io).
const SENTRY_BASE = (process.env.SENTRY_BASE_URL ?? "https://sentry.io").replace(/\/$/, "");

export const CONNECTORS: ConnectorDef[] = [
  {
    id: "calendly",
    name: "Calendly",
    blurb: "Deja que @ghosty consulte tu disponibilidad y comparta tu link de agendamiento.",
    icon: "calendly",
    type: "Web",
    status: "available",
    oauth: {
      authUrl: "https://auth.calendly.com/oauth/authorize",
      tokenUrl: "https://auth.calendly.com/oauth/token",
      pkce: false, // Calendly = Authorization Code confidencial estándar (client_secret_post)
      // Read set: users/me (scheduling_url) + disponibilidad real + próximas citas + tipos de
      // evento → el ambientContext del DM enriquece con esto en intención de agenda (read-aware,
      // 100% lado Teams, sin rebake del worker). El write (scheduling_links:write) ya está
      // cableado en el tool-loop del agente (calendly_create_scheduling_link). Cambiar esto
      // exige RECONECTAR (re-consent) para que el nuevo scope entre al token.
      scopes: "users:read availability:read scheduled_events:read event_types:read scheduling_links:write",
      clientIdEnv: "CALENDLY_CLIENT_ID",
      clientSecretEnv: "CALENDLY_CLIENT_SECRET",
      userInfoUrl: "https://api.calendly.com/users/me",
      parseUserInfo: (j) => ({
        externalId: j?.resource?.uri ?? null,
        meta: {
          scheduling_url: j?.resource?.scheduling_url ?? null,
          name: j?.resource?.name ?? null,
          timezone: j?.resource?.timezone ?? null,
          organization: j?.resource?.current_organization ?? null,
        },
      }),
    },
  },
  {
    id: "denik",
    name: "Deník",
    blurb: "Deja que @ghosty consulte y opere tu agenda de denik.me: citas, disponibilidad y clientes.",
    icon: "denik",
    type: "Web",
    status: "available",
    oauth: {
      authUrl: `${DENIK_BASE}/oauth/authorize`,
      tokenUrl: `${DENIK_BASE}/oauth/token`,
      revokeUrl: `${DENIK_BASE}/oauth/revoke`,
      pkce: true, // Deník exige PKCE S256 ADEMÁS del client_secret.
      // `platform:admin` (lectura cross-tenant) se pide siempre porque este
      // registro es estático, pero Deník sólo lo concede si el correo del
      // usuario está en su lista de administradores; a los demás se lo quita en
      // silencio y les entrega los otros seis. Por eso pedirlo no rompe a nadie.
      // `sales:read` va aparte de `agenda:read` porque del lado de Deník ver la
      // agenda y leer la caja son permisos distintos. Quien conectó ANTES de
      // que existiera este scope no lo tiene: sus tools de ventas responderán
      // 403 hasta que reconecte (el handler ya lo dice con esas palabras).
      scopes:
        "agenda:read agenda:write services:read customers:read customers:write org:read sales:read platform:admin",
      clientIdEnv: "DENIK_CLIENT_ID",
      clientSecretEnv: "DENIK_CLIENT_SECRET",
      userInfoUrl: `${DENIK_BASE}/api/agenda/me`,
      // Guardar aquí las orgs y el flag de admin hace que el contexto ambiente
      // de cada turno se arme LEYENDO LA FILA, sin pegarle a Deník.
      parseUserInfo: (j) => ({
        externalId: j?.userId ?? null,
        meta: {
          email: j?.email ?? null,
          displayName: j?.displayName ?? null,
          activeOrgId: j?.activeOrgId ?? null,
          orgs: j?.orgs ?? [],
          scopes: j?.scopes ?? [],
          isPlatformAdmin: j?.isPlatformAdmin === true,
          // Cuántas cuentas hay en toda la plataforma (sólo viene si es admin).
          // Sirve para que el contexto ambiente le diga al agente que los
          // negocios propios NO son el techo de lo que puede consultar.
          orgsTotalInPlatform: j?.orgsTotalInPlatform ?? null,
        },
      }),
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    blurb:
      "Deja que @ghosty revise los errores de tus proyectos en Sentry: issues, stacktraces, releases y a quién le toca.",
    icon: "sentry",
    type: "Web",
    status: "available",
    oauth: {
      // OAuth2 ESTÁNDAR (authorization code + PKCE S256), anunciado por Sentry en
      // /.well-known/oauth-authorization-server. Token de 30 días, respuesta
      // snake_case: encaja tal cual en el cliente genérico, cero adaptadores.
      //
      // ⚠️ NO confundir con las "Sentry Apps" / integration platform
      // (/sentry-apps/<slug>/external-install/ + /api/0/sentry-app-installations/
      // {id}/authorizations/). Ése PARECE OAuth y no lo es: token endpoint por
      // instalación, body JSON, campos camelCase (token/refreshToken/expiresAt),
      // token de 8 horas, sin PKCE y sin devolver el `state` — o sea que habría
      // roto el relay multi-tenant, que saca el workspace justo de ahí. Sólo vale
      // la pena si algún día queremos webhooks de Sentry o salir en su directorio.
      authUrl: `${SENTRY_BASE}/oauth/authorize/`,
      tokenUrl: `${SENTRY_BASE}/oauth/token/`,
      pkce: true,
      // Lectura completa + event:write, que es lo ÚNICO de escritura y es lo que
      // permite resolver / ignorar / asignar un issue. Cambiar esta lista después
      // obliga a RECONECTAR a todos (no hay upgrade in-place), así que conviene
      // cerrarla de una vez.
      // ⚠️ `project:write` es OBLIGATORIO y se olvidó al principio: el endpoint que
      // registra el webhook de alertas (`POST /projects/{org}/{proj}/legacy-webhooks/`) lo
      // exige, y sin él todo funciona —listar proyectos, issues, stacktraces— salvo
      // justamente activar las alertas, que devuelve un 403 que parece "ese proyecto es de
      // otra organización". Implica `project:read`, así que lo sustituye.
      scopes: "org:read project:write project:releases team:read member:read event:write",
      clientIdEnv: "SENTRY_CLIENT_ID",
      clientSecretEnv: "SENTRY_CLIENT_SECRET",
      // Sentry SÍ tiene /oauth/userinfo/, pero devuelve 403 sin el scope `openid`
      // y sólo trae identidad. Lo que de verdad hace falta para el contexto
      // ambiente es QUÉ organización alcanza este token — ver la nota de abajo.
      userInfoUrl: `${SENTRY_BASE}/api/0/organizations/`,
      // ⚠️ Un token de OAuth Application queda scopeado a UNA organización: la que
      // el usuario eligió en la pantalla de consentimiento. Por eso este array
      // trae normalmente un solo elemento, y por eso el ambientContext la NOMBRA:
      // sin decirlo, el modelo lee "no existe ese proyecto" cuando la verdad es
      // "está en otra org". Conectar una segunda exige re-autorizar.
      parseUserInfo: (j) => {
        const orgs = Array.isArray(j) ? j : [];
        return {
          externalId: orgs[0]?.id ? String(orgs[0].id) : null,
          meta: {
            orgs: orgs.map((o: any) => ({ id: o?.id ?? null, slug: o?.slug ?? null, name: o?.name ?? null })),
          },
        };
      },
      metaTtlS: 900,
      // Sin `revokeUrl`: Sentry no expone un endpoint RFC 7009. Desconectar borra
      // la fila local; la autorización sigue viva en la cuenta del usuario hasta
      // que la quite en Settings → Account → Authorized Applications.
    },
  },
  {
    id: "github",
    name: "GitHub",
    blurb:
      "Deja que @ghosty trabaje en tus repos: lee issues y PRs, revisa código, escribe en una rama y abre pull requests.",
    icon: "github",
    type: "Web",
    status: "available",
    // La MISMA liga sirve para instalar y para agregar repos: GitHub reconoce
    // el estado de la cuenta y muestra la pantalla que toca.
    manage: {
      url: `https://github.com/apps/${process.env.GITHUB_APP_SLUG ?? "ghosty-studio"}/installations/new`,
      label: "Elegir repos",
    },
    oauth: {
      // Es una GitHub APP en flujo user-to-server, no una OAuth App. La
      // diferencia que importa: el usuario elige QUÉ REPOS al instalar, en vez
      // de entregar todos sus repos privados de golpe (que es lo único que
      // sabe hacer el scope `repo` de una OAuth App).
      // ⚠️ Apunta a la URL de INSTALACIÓN, no a /login/oauth/authorize. Con
      // "Request user authorization (OAuth) during installation" activo en la
      // app, esta URL hace los DOS pasos en una pantalla ("Install & Authorize")
      // y vuelve al callback con `code` + `installation_id` + `state`. Es el
      // patrón que usan CodeRabbit y compañía, y el único que le pregunta al
      // usuario QUÉ REPOS.
      //
      // Con /login/oauth/authorize el usuario queda autorizado pero SIN app
      // instalada, y todas las tools fallan con un 404 que parece "no existe".
      // Instalación y autorización son independientes en GitHub: ése es el
      // origen de toda la confusión.
      //
      // De las URLs de instalación, `/installations/new` es la ÚNICA que
      // propaga `state` — y el state lleva el workspace, así que sin él el
      // relay del apex no sabría a qué subdominio volver.
      authUrl: `https://github.com/apps/${process.env.GITHUB_APP_SLUG ?? "ghosty-studio"}/installations/new`,
      tokenUrl: "https://github.com/login/oauth/access_token",
      noRedirectUri: true,
      // ⚠️ Sin esto GitHub responde form-encoded y el res.json() del cliente
      // genérico revienta. Es el único proveedor que lo necesita.
      tokenHeaders: { Accept: "application/json" },
      // GitHub Apps no soportan PKCE, y no llevan `scope` en el authorize: los
      // permisos son los declarados en la app y se conceden al instalarla.
      pkce: false,
      clientIdEnv: "GITHUB_CLIENT_ID",
      clientSecretEnv: "GITHUB_CLIENT_SECRET",
      userInfoUrl: "https://api.github.com/user",
      parseUserInfo: (j) => ({
        externalId: j?.id != null ? String(j.id) : null,
        meta: { login: j?.login ?? null, name: j?.name ?? null, avatarUrl: j?.avatar_url ?? null },
      }),
      metaTtlS: 900,
      // Sin `revokeUrl`: revocar exige Basic auth con el client secret contra
      // /applications/{client_id}/grant, que no es RFC 7009 y el cliente
      // genérico no sabe emitir. Desconectar borra la fila local; el usuario
      // quita la instalación en github.com/settings/installations.
    },
  },
  // Próximamente (sin oauth aún → el panel los muestra como "Próximamente"):
  { id: "hubspot", name: "HubSpot", blurb: "Trae contactos y negocios de tu CRM; @ghosty responde con ese contexto.", icon: "hubspot", type: "Web", status: "soon" },
  { id: "google-calendar", name: "Google Calendar", blurb: "Recordatorios y contexto de reuniones dentro del room.", icon: "google-calendar", type: "Web", status: "soon" },
];

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
