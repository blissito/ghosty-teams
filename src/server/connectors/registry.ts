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
  oauth?: {
    authUrl: string;
    tokenUrl: string;
    scopes?: string; // omitido si el provider no usa scopes (Calendly)
    pkce?: boolean;
    clientIdEnv: string;
    clientSecretEnv: string;
    userInfoUrl?: string; // tras conectar: captura external_id + meta
    // Traduce la respuesta del userInfoUrl a lo que se persiste. Cada proveedor
    // devuelve una forma distinta; sin esto el parser de UNO quedaba escrito a
    // mano dentro de finishConnectFn y los demás se quedaban sin meta.
    parseUserInfo?: (json: any) => { externalId: string | null; meta: unknown };
    // RFC 7009. Al desconectar, borrar la fila local sólo deja de USAR el token:
    // sigue vivo del lado del proveedor hasta que expire. Con esto se revoca de
    // verdad — indispensable cuando el token concede lectura cross-tenant.
    revokeUrl?: string;
  };
};

// Base de la API de Deník. Override por env para apuntar a una instancia local
// (el flujo OAuth completo se puede ejercitar sin dominio público).
const DENIK_BASE = (process.env.DENIK_BASE_URL ?? "https://www.denik.me").replace(/\/$/, "");

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
      scopes:
        "agenda:read agenda:write services:read customers:read customers:write org:read platform:admin",
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
  // Próximamente (sin oauth aún → el panel los muestra como "Próximamente"):
  { id: "github", name: "GitHub", blurb: "Trae issues y PRs al chat; @ghosty los resume y comenta.", icon: "github", type: "Web", status: "soon" },
  { id: "hubspot", name: "HubSpot", blurb: "Trae contactos y negocios de tu CRM; @ghosty responde con ese contexto.", icon: "hubspot", type: "Web", status: "soon" },
  { id: "google-calendar", name: "Google Calendar", blurb: "Recordatorios y contexto de reuniones dentro del room.", icon: "google-calendar", type: "Web", status: "soon" },
];

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
