// La computadora del agente en el cliente: los pasos por burbuja (`messageId`). Los llena el
// evento `computer:steps` del room (en vivo) o, al abrir el panel de un turno viejo, la lectura
// de `gt_computer`. La tarjeta del checklist y el panel leen del mismo lugar.
import { useEffect, useSyncExternalStore } from "react";
import type { AgentStep } from "@ghostystudio/computer";
import { getComputerStepsFn } from "../server/chat";

const byMessage = new Map<number, AgentStep[]>();
const listeners = new Set<() => void>();
const loading = new Set<number>();

export function setComputerSteps(messageId: number, steps: AgentStep[]): void {
  byMessage.set(messageId, steps);
  // Tope: una pestaña abierta todo el día no debe guardar los pasos de cada turno.
  if (byMessage.size > 60) byMessage.delete(byMessage.keys().next().value!);
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: AgentStep[] = [];

/** Los pasos de una burbuja; si no llegaron en vivo, los pide una vez a la base. */
export function useComputerSteps(messageId: number): { steps: AgentStep[]; loaded: boolean } {
  const steps = useSyncExternalStore(subscribe, () => byMessage.get(messageId) ?? EMPTY, () => EMPTY);
  const loaded = byMessage.has(messageId);
  useEffect(() => {
    if (loaded || loading.has(messageId)) return;
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
  }, [messageId, loaded]);
  return { steps, loaded };
}
