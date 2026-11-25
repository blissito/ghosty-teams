// La computadora del agente en el cliente: los pasos por burbuja (`messageId`). Los llena el
// evento `computer:steps` del room (en vivo) o, al abrir el panel de un turno viejo, la lectura
// de `gt_computer`. La tarjeta del checklist y el panel leen del mismo lugar.
import { useEffect, useSyncExternalStore } from "react";
import type { AgentStep } from "@ghostystudio/computer";
import { getComputerStepsFn } from "../server/chat";

const byMessage = new Map<number, AgentStep[]>();
// Si el turno de la burbuja sigue (lo dice cada `computer:steps`; lo leído de la base ya terminó).
const liveTurn = new Map<number, boolean>();
const listeners = new Set<() => void>();
const loading = new Set<number>();
// Cuántos componentes montados miran cada burbuja: ésas no se expulsan del tope.
const mounted = new Map<number, number>();

/** La entrada más vieja que nadie está mirando (o undefined si todas están montadas). */
function oldestUnmounted<V>(m: Map<number, V>): number | undefined {
  for (const k of m.keys()) if (!mounted.has(k)) return k;
}

export function setComputerSteps(messageId: number, steps: AgentStep[], live = false): void {
  // Se borra antes de poner: así la burbuja queda al final (la más reciente) del orden de expulsión.
  byMessage.delete(messageId);
  byMessage.set(messageId, steps);
  liveTurn.delete(messageId);
  liveTurn.set(messageId, live);
  // Tope: una pestaña abierta todo el día no debe guardar los pasos de cada turno. Nunca se
  // expulsa una burbuja montada: con más de 60 en pantalla se expulsaban entre sí, cada una
  // volvía a pedir sus pasos y el panel abierto parpadeaba en blanco cada segundo (25-nov).
  if (byMessage.size > 60) {
    const k = oldestUnmounted(byMessage);
    if (k !== undefined) byMessage.delete(k);
  }
  if (liveTurn.size > 60) {
    const k = oldestUnmounted(liveTurn);
    if (k !== undefined) liveTurn.delete(k);
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: AgentStep[] = [];

/**
 * Los pasos de una burbuja; si no llegaron en vivo, los pide una vez a la base (salvo
 * `fetch: false`: la tarjeta de un turno terminado no se pinta y no tiene por qué pedirlos).
 */
export function useComputerSteps(messageId: number, { fetch = true }: { fetch?: boolean } = {}): { steps: AgentStep[]; loaded: boolean; live: boolean } {
  const steps = useSyncExternalStore(subscribe, () => byMessage.get(messageId) ?? EMPTY, () => EMPTY);
  const loaded = byMessage.has(messageId);
  useEffect(() => {
    mounted.set(messageId, (mounted.get(messageId) ?? 0) + 1);
    return () => {
      const n = (mounted.get(messageId) ?? 1) - 1;
      if (n > 0) mounted.set(messageId, n);
      else mounted.delete(messageId);
    };
  }, [messageId]);
  useEffect(() => {
    if (!fetch || loaded || loading.has(messageId)) return;
    loading.add(messageId);
    void getComputerStepsFn({ data: { id: messageId } })
      .then((r) => {
        // Lo que llegó en vivo mientras tanto gana: es más nuevo.
        if (!byMessage.has(messageId)) setComputerSteps(messageId, r.steps);
      })
      .catch(() => {
        if (!byMessage.has(messageId)) setComputerSteps(messageId, []);
      })
      .finally(() => loading.delete(messageId));
  }, [messageId, loaded, fetch]);
  return { steps, loaded, live: liveTurn.get(messageId) === true };
}

/**
 * El navegador de esa sesión ya no existe (gs contestó 410): su «Te necesito aquí» se da por
 * cerrado aquí mismo. Sin esto la tarjeta seguía ofreciendo «Tomar el control» sobre una pestaña
 * muerta, con «El navegador ya se cerró» en rojo debajo (24-oct).
 */
export function closeComputerAsk(messageId: number, sessionId: string): void {
  const steps = byMessage.get(messageId);
  if (!steps?.some((s) => s.status === "running" && s.browser?.needsHuman && s.browser.sessionId === sessionId)) return;
  const now = Date.now();
  setComputerSteps(
    messageId,
    steps.map((s) => (s.status === "running" && s.browser?.needsHuman && s.browser.sessionId === sessionId ? { ...s, status: "error" as const, endedAt: now } : s)),
    liveTurn.get(messageId) === true,
  );
}
