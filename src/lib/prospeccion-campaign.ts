/**
 * El SIGUIENTE PASO de una campaña, uno solo.
 *
 * La barra de campaña no enseña un asistente de pasos fijos: dice qué falta para poder
 * mandar, en el orden en que de verdad estorba. Así la persona nunca tiene que adivinar si
 * ya puede enviar ni por qué el botón no hace nada.
 */
export type CampaignState = {
  /** El cierre del correo: botón a WhatsApp, responder o enlace. */
  ctaKind: "wa" | "reply" | "link";
  waPhone: string;
  senderName: string;
  /** Hay mensaje base o alguna columna de mensaje escrita por el agente. */
  hasMessage: boolean;
  /** Ya se mandó al menos una prueba en esta campaña. */
  testSent: boolean;
  /** Filas a la vista con correo y sin correo enviado todavía: a quienes de verdad saldría. */
  shown: number;
  /** Correos ya enviados de esta campaña. */
  sent?: number;
};

export type NextStep =
  | { id: "setup"; missing: ("whatsapp" | "sender")[] }
  | { id: "message" }
  | { id: "test" }
  | { id: "send"; n: number }
  | { id: "done"; sent: number }
  | { id: "empty" };

export function nextStep(s: CampaignState): NextStep {
  const missing: ("whatsapp" | "sender")[] = [];
  if (s.ctaKind === "wa" && !s.waPhone.trim()) missing.push("whatsapp");
  if (!s.senderName.trim()) missing.push("sender");
  if (missing.length) return { id: "setup", missing };
  if (!s.hasMessage) return { id: "message" };
  if (!s.testSent) return { id: "test" };
  // Ya salió a todos los de la vista: no se ofrece «Enviar a 0», se dice que ya salió.
  if (!s.shown) return s.sent ? { id: "done", sent: s.sent } : { id: "empty" };
  return { id: "send", n: s.shown };
}
