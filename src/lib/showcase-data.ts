// Lo que el invitado de un evento ve ALREDEDOR del room del evento.
//
// ⚠️ TODO ESTO ES FALSO, y tiene que seguir siéndolo. La tentación obvia es enseñar los
// rooms de verdad del workspace "para que se vea real": no. Un room puede llamarse
// "Despido Juan", "Ronda serie A" o "Demanda Pérez", y en un webinar lo verían 100
// desconocidos sin que haya forma de deshacerlo. El único contenido vivo de la sala es el
// room del evento; lo demás es escaparate.
//
// Es un archivo y no una tabla a propósito: se edita antes de cada demo para enseñar lo
// que convenga ese día, sin migración y sin panel que mantener.

export type ShowcaseRoom = { name: string; topic?: string; unread?: number };
export type ShowcaseDm = { name: string; online?: boolean };

/** Rooms de la barra lateral. El del evento se inserta aparte y va marcado EN VIVO. */
export const SHOWCASE_ROOMS: ShowcaseRoom[] = [
  { name: "general" },
  { name: "anuncios", unread: 2 },
  { name: "ventas", topic: "Pipeline y propuestas" },
  { name: "producto", unread: 5 },
  { name: "diseño" },
  { name: "soporte", topic: "Tickets del día" },
  { name: "contabilidad" },
];

export const SHOWCASE_DMS: ShowcaseDm[] = [
  { name: "Ana Ruiz", online: true },
  { name: "Diego Marín", online: true },
  { name: "Paula Sanz" },
  { name: "Equipo legal" },
];

/**
 * Artefactos del panel derecho. Son los tipos que el producto genera de verdad
 * —documento, hoja, PDF maquetado, formulario— porque lo que se está enseñando es que el
 * agente PRODUCE cosas, no que conversa.
 */
export const SHOWCASE_ARTIFACTS = [
  { title: "Propuesta comercial · Vidriera Norte", kind: "PDF", when: "hace 12 min" },
  { title: "Reporte de ventas · agosto", kind: "Hoja", when: "hace 1 h" },
  { title: "Contrato de servicios (v4)", kind: "Documento", when: "ayer" },
  { title: "Alta de proveedor", kind: "Formulario", when: "ayer" },
];
