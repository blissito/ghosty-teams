// Conector Deník (denik.me) per-user. Calca el molde de calendly.server.ts:
// `ambientContext` es BARATO (lee el meta capturado al conectar, sin round-trip) y
// las capacidades ricas viven en `tools` que el agente invoca on-demand.
//
// El token de Deník NUNCA sale de Teams: la caja del agente sólo tiene un
// tool-token HMAC de 15 min con su `sub` firmado, y los handlers de aquí corren
// en el servidor de Teams. Es lo que hace tolerable que un token pueda traer
// permisos de administración de plataforma.
import { getValidToken } from "./oauth.server";
import { getConnectorRow } from "./store.server";
import type { ConnectorTool } from "./impl";

const BASE = (process.env.DENIK_BASE_URL ?? "https://www.denik.me").replace(/\/$/, "");

type DenikMeta = {
  email?: string | null;
  displayName?: string | null;
  activeOrgId?: string | null;
  orgs?: Array<{ id: string; name: string; slug: string; timezone: string; role: string }>;
  scopes?: string[];
  isPlatformAdmin?: boolean;
  orgsTotalInPlatform?: number;
};

async function readMeta(sub: string): Promise<DenikMeta | null> {
  const row = await getConnectorRow(sub, "denik");
  if (!row?.access_token || !row.meta) return null;
  try {
    return JSON.parse(row.meta) as DenikMeta;
  } catch {
    return null;
  }
}

/**
 * Llamada a la API de Deník con el token del usuario.
 *
 * Los errores se traducen a español accionable en vez de propagar el status:
 * lo que devuelve esta función se lo lee el MODELO, y "401" lo lleva a inventar
 * excusas, mientras que "reconecta Deník en Ajustes" lo lleva a decirle al
 * usuario exactamente qué hacer.
 */
async function api(sub: string, path: string, init?: RequestInit): Promise<unknown> {
  const token = await getValidToken(sub, "denik");
  if (!token) {
    return { error: "La cuenta de Deník no está conectada. Conéctala en Ajustes → Integraciones." };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    return { error: `No pude contactar a Deník: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.ok) return await res.json().catch(() => ({}));

  const body = (await res.text().catch(() => "")).slice(0, 400);
  if (res.status === 401) {
    return { error: "La sesión de Deník expiró. Pídele que reconecte Deník en Ajustes → Integraciones." };
  }
  if (res.status === 403) {
    // Puede ser un scope faltante o una org ajena. Ambos se arreglan distinto,
    // así que no se colapsan en un solo mensaje.
    if (body.includes("org_not_authorized")) {
      return { error: "Ese negocio no pertenece a su cuenta de Deník." };
    }
    return {
      error:
        "Faltan permisos en la conexión con Deník. Pídele que la reconecte en Ajustes → Integraciones para re-autorizar.",
    };
  }
  if (res.status === 402) {
    return { error: "El plan de esa cuenta de Deník está vencido." };
  }
  if (res.status === 404) return { error: "No encontrado en Deník." };
  return { error: `Deník respondió ${res.status}: ${body}` };
}

const qs = (args: Record<string, unknown>, keys: string[]): string => {
  const p = new URLSearchParams();
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ── Contexto ambiente ────────────────────────────────────────────────────────

export async function ambientContext(sub: string, sender: string, _message: string): Promise<string | null> {
  const meta = await readMeta(sub);
  if (!meta) return null;

  const orgs = meta.orgs ?? [];
  const orgList = orgs.length
    ? orgs
        .map((o) => `${o.name}${o.id === meta.activeOrgId ? " (activo)" : ""}`)
        .join(", ")
    : "sin negocios configurados";

  let block =
    `[INTEGRACIÓN Deník de ${sender} (conectada). Negocios: ${orgList}. ` +
    `TIENES HERRAMIENTAS para su agenda vía el GS Tools SDK: importa /opt/gs-sdk/connectors.mjs y usa ` +
    `list() y run(name, args). Tools: denik_my_orgs, denik_upcoming_appointments, denik_search_appointments, ` +
    `denik_get_appointment, denik_services, denik_availability, denik_org_summary, denik_sales, ` +
    `denik_create_appointment, ` +
    `denik_reschedule_appointment, denik_cancel_appointment, denik_mark_attendance, denik_send_reminder, ` +
    `denik_find_customer, denik_customer_history, denik_create_customer. ` +
    `Para preguntas de DINERO (cuánto se cobró, por qué método, qué falta por cobrar) usa denik_sales, ` +
    `no denik_org_summary. ` +
    `Para CUALQUIER pregunta sobre citas, horarios, disponibilidad o clientes de ${sender}, USA estas tools — ` +
    `NO inventes datos ni digas que no tienes acceso (SÍ lo tienes). Todas aceptan orgId opcional; ` +
    `si se omite se usa el negocio activo. Al MOSTRAR horas usa siempre el campo startLocal, nunca el ISO/UTC. ` +
    `Si una tool devuelve error de permiso, pídele que reconecte Deník en Ajustes → Integraciones.`;

  if (meta.isPlatformAdmin) {
    // Sin esto el agente leía "tiene 2 negocios" como "sólo puede ver 2" y se lo
    // respondía así a un administrador (le pasó a Brenda: 2 con rol, 12 en la
    // plataforma). Los negocios propios NO son el techo de lo que puede consultar.
    const total = meta.orgsTotalInPlatform;
    block +=
      ` IMPORTANTE: es administrador de la plataforma Deník, así que los negocios de arriba son sólo aquellos donde tiene un rol — NO son el límite de lo que puede consultar. Puede ver ${total ? `las ${total} cuentas` : "TODAS las cuentas"} de Deník: lístalas con denik_admin_list_orgs y pasa el orgId que te devuelva a cualquier otra tool (citas, servicios, clientes, resumen). Si pregunta "cuántos negocios hay" o pide ver otra cuenta, NO respondas con los suyos.` +
      ` Tiene tools de SOLO LECTURA sobre todas las cuentas: ` +
      `denik_admin_list_orgs, denik_admin_platform_stats, denik_admin_events, denik_admin_usage, ` +
      `denik_admin_sales, denik_admin_sales_detail, denik_admin_overview. ` +
      `Si pregunta por un negocio en una fecha concreta ("cuántas citas y cuánto entró el martes en X"), ` +
      `denik_admin_overview lo responde en UNA llamada. ` +
      `CUIDADO al hablar de dinero: las citas se cuentan por cuándo OCURREN y el dinero por cuándo ENTRÓ, ` +
      `así que son conjuntos distintos aunque sea el mismo día — cada bloque trae su campo basis; no los ` +
      `sumes ni los presentes como si fueran lo mismo. ` +
      `Úsalas SÓLO si lo pide explícitamente y NUNCA compartas datos de otras cuentas en un canal ` +
      `donde haya alguien más.`;
  }

  return `${block}]`;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const str = (description: string) => ({ type: "string", description });
const orgIdProp = {
  orgId: str("Id del negocio. Omítelo para usar el activo del usuario."),
};

const USER_TOOLS: ConnectorTool[] = [
  {
    name: "denik_my_orgs",
    description:
      "Lista los negocios donde el usuario tiene un ROL, con su zona horaria, e indica cuál es el activo. OJO: si es administrador de plataforma esto NO es todo lo que puede consultar — para las demás cuentas usa denik_admin_list_orgs y pásale el orgId a las otras tools.",
    inputSchema: { type: "object", properties: {} },
    handler: (sub) => api(sub, "/api/agenda/me"),
  },
  {
    name: "denik_upcoming_appointments",
    description:
      "Próximas citas agendadas, de la más cercana en adelante (excluye canceladas). Es la forma correcta de responder '¿qué tengo?' o '¿cómo viene mi semana?'.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        limit: { type: "number", description: "Cuántas devolver (1-50, default 10)." },
      },
    },
    handler: (sub, a) =>
      api(sub, `/api/agenda/events${qs({ ...a, intent: "upcoming" }, ["intent", "orgId", "limit"])}`),
  },
  {
    name: "denik_search_appointments",
    description:
      "Busca citas por rango de fechas y filtros. Las fechas pueden ir como YYYY-MM-DD (se interpretan como el día completo en la zona del negocio).",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        from: str("Desde. YYYY-MM-DD o ISO."),
        to: str("Hasta. YYYY-MM-DD o ISO."),
        status: str("Filtra por estado, p.ej. confirmed o pending."),
        serviceId: str("Sólo citas de este servicio."),
        customerId: str("Sólo citas de este cliente."),
        attended: { type: "boolean", description: "true = asistió, false = no asistió." },
        limit: { type: "number", description: "Máximo a devolver (1-200, default 50)." },
      },
    },
    handler: (sub, a) =>
      api(
        sub,
        `/api/agenda/events${qs({ ...a, intent: "list" }, [
          "intent",
          "orgId",
          "from",
          "to",
          "status",
          "serviceId",
          "customerId",
          "attended",
          "limit",
        ])}`
      ),
  },
  {
    name: "denik_get_appointment",
    description: "Detalle completo de una cita por su id.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, eventId: str("Id de la cita.") },
      required: ["eventId"],
    },
    handler: (sub, a) =>
      api(sub, `/api/agenda/events${qs({ ...a, intent: "get" }, ["intent", "orgId", "eventId"])}`),
  },
  {
    name: "denik_services",
    description:
      "Catálogo de servicios agendables: nombre, precio, duración y modalidad. Necesitas el serviceId de aquí para consultar disponibilidad o crear una cita.",
    inputSchema: { type: "object", properties: { ...orgIdProp } },
    handler: (sub, a) => api(sub, `/api/agenda/services${qs(a, ["orgId"])}`),
  },
  {
    name: "denik_availability",
    description:
      "Horarios libres de un servicio. Pide varios días de una vez con `days` en lugar de llamar día por día.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        serviceId: str("Id del servicio (de denik_services)."),
        serviceSlug: str("Alternativa al id."),
        date: str("Día inicial YYYY-MM-DD. Default: hoy en la zona del negocio."),
        days: { type: "number", description: "Cuántos días consecutivos consultar (1-14, default 1)." },
      },
    },
    handler: (sub, a) =>
      api(sub, `/api/agenda/availability${qs(a, ["orgId", "serviceId", "serviceSlug", "date", "days"])}`),
  },
  {
    name: "denik_org_summary",
    description:
      "Resumen del negocio: citas totales, confirmadas, canceladas, asistencias e ingresos en un rango. Sin from/to devuelve el día de hoy.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, from: str("Desde YYYY-MM-DD."), to: str("Hasta YYYY-MM-DD.") },
    },
    handler: (sub, a) => {
      const intent = a.from && a.to ? "stats" : "today";
      return api(sub, `/api/agenda/org${qs({ ...a, intent }, ["intent", "orgId", "from", "to"])}`);
    },
  },
  {
    name: "denik_sales",
    description:
      "La CAJA del negocio: cuánto se cobró, por qué método (efectivo, transferencia, tarjeta, MercadoPago, bono) y por qué servicio, más lo que está por cobrar. Devuelve los mismos números que el dueño ve en su panel de Ventas. Úsala para preguntas de dinero — denik_org_summary es de agenda. Con detail=true lista cobro por cobro (incluye reembolsos) y ahí el rango es obligatorio. El rango es por fecha de COBRO, no de la cita.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        from: str("Desde YYYY-MM-DD. Sin rango, el resumen es histórico completo."),
        to: str("Hasta YYYY-MM-DD."),
        detail: {
          type: "boolean",
          description: "true = lista de cobros individuales en vez del resumen.",
        },
        limit: { type: "number", description: "Sólo con detail. 1-200, default 50." },
      },
    },
    handler: (sub, a) => {
      const intent = a.detail ? "detail" : "summary";
      return api(
        sub,
        `/api/agenda/sales${qs({ ...a, intent }, ["intent", "orgId", "from", "to", "limit"])}`,
      );
    },
  },
  {
    name: "denik_create_appointment",
    description:
      "Agenda una cita. Requiere serviceId y customerId (créalo antes con denik_create_customer si no existe) y la hora de inicio en ISO. Verifica disponibilidad primero.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        serviceId: str("Id del servicio."),
        customerId: str("Id del cliente."),
        start: str("Inicio en ISO 8601, p.ej. 2026-07-28T15:00:00Z."),
        notes: str("Notas internas."),
      },
      required: ["serviceId", "customerId", "start"],
    },
    handler: (sub, a) =>
      api(sub, "/api/agenda/events", { method: "POST", body: JSON.stringify({ ...a, intent: "create" }) }),
  },
  {
    name: "denik_reschedule_appointment",
    description:
      "Mueve una cita a otro horario. Notifica al cliente y, si estaba confirmada, vuelve a quedar pendiente de su confirmación.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, eventId: str("Id de la cita."), start: str("Nuevo inicio en ISO 8601.") },
      required: ["eventId", "start"],
    },
    handler: (sub, a) =>
      api(sub, "/api/agenda/events", { method: "POST", body: JSON.stringify({ ...a, intent: "reschedule" }) }),
  },
  {
    name: "denik_cancel_appointment",
    description: "Cancela una cita y avisa al cliente. Confirma con el usuario antes de usarla.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, eventId: str("Id de la cita.") },
      required: ["eventId"],
    },
    handler: (sub, a) =>
      api(sub, "/api/agenda/events", { method: "POST", body: JSON.stringify({ ...a, intent: "cancel" }) }),
  },
  {
    name: "denik_mark_attendance",
    description: "Marca si el cliente asistió a una cita.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        eventId: str("Id de la cita."),
        attended: { type: "boolean", description: "true = asistió, false = no asistió." },
      },
      required: ["eventId", "attended"],
    },
    handler: (sub, a) =>
      api(sub, "/api/agenda/events", {
        method: "POST",
        body: JSON.stringify({ ...a, intent: "mark_attendance" }),
      }),
  },
  {
    name: "denik_send_reminder",
    description: "Envía por correo el recordatorio de una cita al cliente.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, eventId: str("Id de la cita.") },
      required: ["eventId"],
    },
    handler: (sub, a) =>
      api(sub, "/api/agenda/events", {
        method: "POST",
        body: JSON.stringify({ ...a, intent: "send_reminder" }),
      }),
  },
  {
    name: "denik_find_customer",
    description: "Busca clientes por nombre, correo o teléfono.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, q: str("Texto a buscar.") },
      required: ["q"],
    },
    handler: (sub, a) =>
      api(sub, `/api/agenda/customers${qs({ ...a, intent: "find" }, ["intent", "orgId", "q"])}`),
  },
  {
    name: "denik_customer_history",
    description: "Historial de citas de un cliente, de la más reciente hacia atrás.",
    inputSchema: {
      type: "object",
      properties: { ...orgIdProp, customerId: str("Id del cliente."), limit: { type: "number" } },
      required: ["customerId"],
    },
    handler: (sub, a) =>
      api(
        sub,
        `/api/agenda/customers${qs({ ...a, intent: "appointments" }, ["intent", "orgId", "customerId", "limit"])}`
      ),
  },
  {
    name: "denik_create_customer",
    description:
      "Da de alta un cliente. Si ya existe uno con ese correo devuelve el existente en vez de duplicarlo, así que es seguro reintentar.",
    inputSchema: {
      type: "object",
      properties: {
        ...orgIdProp,
        displayName: str("Nombre del cliente."),
        email: str("Correo."),
        tel: str("Teléfono."),
      },
      required: ["displayName"],
    },
    handler: (sub, a) =>
      api(sub, "/api/agenda/customers", { method: "POST", body: JSON.stringify({ ...a, intent: "create" }) }),
  },
];

// Sólo para el equipo de Deník. SOLO LECTURA por diseño del lado del servidor.
const ADMIN_TOOLS: ConnectorTool[] = [
  {
    name: "denik_admin_overview",
    description:
      "[Admin plataforma] Corte completo de UN negocio en un día o rango: agenda + caja + cobro por cobro. ÚSALA como primera opción cuando pregunten por un negocio en una fecha concreta ('cuántas citas y cuánto entró el martes en X'). Devuelve dos bloques que NO son el mismo conjunto: `agenda` cuenta las citas que OCURREN en el periodo (por start) y `caja` el dinero que ENTRÓ (por createdAt) — no los sumes ni los cruces, cada uno trae su campo `basis`.",
    inputSchema: {
      type: "object",
      properties: {
        orgId: str("Id del negocio. Obligatorio."),
        date: str("Un día: YYYY-MM-DD. Alternativa a from/to."),
        from: str("Inicio del rango YYYY-MM-DD (si no usas date)."),
        to: str("Fin del rango YYYY-MM-DD (si no usas date)."),
        limit: { type: "number", description: "Cobros a listar. 1-500, default 200." },
      },
      required: ["orgId"],
    },
    handler: (sub, a) =>
      api(sub, `/api/agenda/admin/overview${qs(a, ["orgId", "date", "from", "to", "limit"])}`),
  },
  {
    name: "denik_admin_sales",
    description:
      "[Admin plataforma] Ventas en un rango: desglose por método de cobro y por servicio, pagado vs por cobrar, incluyendo la venta de paquetes (bonos). Sin orgId agrega TODA la plataforma y trae el ranking de negocios por ingreso; con orgId, sólo ese negocio. El rango es por fecha de COBRO, no por fecha de la cita. En `byMethod`, `free` significa servicio gratis (no hubo cobro) y `unknown` que de verdad no se sabe — no los confundas.",
    inputSchema: {
      type: "object",
      properties: {
        from: str("Desde YYYY-MM-DD."),
        to: str("Hasta YYYY-MM-DD."),
        orgId: str("Opcional: limita a un negocio."),
      },
      required: ["from", "to"],
    },
    handler: (sub, a) => api(sub, `/api/agenda/admin/sales${qs(a, ["from", "to", "orgId"])}`),
  },
  {
    name: "denik_admin_sales_detail",
    description:
      "[Admin plataforma] Cobros individuales (citas y paquetes) con monto real, método, estado y negocio. Aquí SÍ aparecen los reembolsos. Rango obligatorio y tope de 200; si `truncated` viene true, viste una muestra y no la caja completa — dilo así.",
    inputSchema: {
      type: "object",
      properties: {
        from: str("Desde YYYY-MM-DD."),
        to: str("Hasta YYYY-MM-DD."),
        orgId: str("Limita a un negocio."),
        status: str("paid | pending | refunded | cancelled."),
        method: str("mercadopago | stripe | cash | transfer | card | package | free."),
        limit: { type: "number", description: "1-200, default 50." },
      },
      required: ["from", "to"],
    },
    handler: (sub, a) =>
      api(
        sub,
        `/api/agenda/admin/sales/detail${qs(a, ["from", "to", "orgId", "status", "method", "limit"])}`,
      ),
  },
  {
    name: "denik_admin_list_orgs",
    description:
      "[Admin plataforma] Lista TODAS las cuentas de Deník con su dueño, plan y actividad de los últimos 30 días.",
    inputSchema: {
      type: "object",
      properties: {
        q: str("Filtra por nombre, slug o correo."),
        sort: str("cost | name | recent. Default: cost."),
        limit: { type: "number", description: "1-200, default 50." },
        offset: { type: "number" },
      },
    },
    handler: (sub, a) => api(sub, `/api/agenda/admin/orgs${qs(a, ["q", "sort", "limit", "offset"])}`),
  },
  {
    name: "denik_admin_platform_stats",
    description:
      "[Admin plataforma] Agregado de toda la plataforma en un rango: citas, asistencias, ingresos y distribución por plan. Con orgId, sólo esa cuenta. El rango es obligatorio.",
    inputSchema: {
      type: "object",
      properties: { from: str("Desde YYYY-MM-DD."), to: str("Hasta YYYY-MM-DD."), orgId: str("Opcional.") },
      required: ["from", "to"],
    },
    handler: (sub, a) => api(sub, `/api/agenda/admin/stats${qs(a, ["from", "to", "orgId"])}`),
  },
  {
    name: "denik_admin_events",
    description:
      "[Admin plataforma] Citas de todas las cuentas en un rango, cada una etiquetada con su negocio. Rango obligatorio y tope de 200.",
    inputSchema: {
      type: "object",
      properties: {
        from: str("Desde YYYY-MM-DD."),
        to: str("Hasta YYYY-MM-DD."),
        orgId: str("Limita a una cuenta."),
        status: str("Filtra por estado."),
        limit: { type: "number", description: "1-200, default 50." },
      },
      required: ["from", "to"],
    },
    handler: (sub, a) =>
      api(sub, `/api/agenda/admin/events${qs(a, ["from", "to", "orgId", "status", "limit"])}`),
  },
  {
    name: "denik_admin_usage",
    description:
      "[Admin plataforma] Consumo de IA por cuenta (generación de landings). Los costos son ESTIMADOS, no facturación real: dilo así al reportarlos.",
    inputSchema: {
      type: "object",
      properties: { month: str("YYYY-MM. Default: mes actual."), limit: { type: "number" } },
    },
    handler: (sub, a) => api(sub, `/api/agenda/admin/usage${qs(a, ["month", "limit"])}`),
  },
];

/**
 * Set de tools según QUIÉN es el usuario.
 *
 * A quien no es administrador de plataforma ni siquiera se le muestran las
 * `denik_admin_*`: fallarían con 403 de todos modos, y anunciarle al modelo
 * cuatro acciones que no puede ejecutar sólo gasta contexto e invita a intentos
 * fallidos. El gate REAL está del lado de Deník; esto es higiene de prompt.
 */
export async function tools(sub: string): Promise<ConnectorTool[]> {
  const meta = await readMeta(sub);
  return meta?.isPlatformAdmin ? [...USER_TOOLS, ...ADMIN_TOOLS] : USER_TOOLS;
}
