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
  };
};

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
      clientIdEnv: "CALENDLY_CLIENT_ID",
      clientSecretEnv: "CALENDLY_CLIENT_SECRET",
      userInfoUrl: "https://api.calendly.com/users/me",
    },
  },
  // Próximamente (sin oauth aún → el panel los muestra como "Próximamente"):
  { id: "github", name: "GitHub", blurb: "Trae issues y PRs al chat; @ghosty los resume y comenta.", icon: "github", type: "Web", status: "soon" },
  { id: "slack", name: "Slack", blurb: "Reenvía canales y menciones desde tu workspace de Slack.", icon: "slack", type: "Web", status: "soon" },
  { id: "google-calendar", name: "Google Calendar", blurb: "Recordatorios y contexto de reuniones dentro del room.", icon: "google-calendar", type: "Web", status: "soon" },
];

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
