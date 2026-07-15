// Bus mínimo para invalidar el cache de menciones (agentes + usuarios) cuando cambian:
// crear/borrar/editar/toggle de un agente ocurre en el modal de Ajustes, pero el picker
// del composer (useMentions) vive en otro árbol con su propio cache de módulo → sin esto,
// borrar un agente lo dejaba fantasma en el picker hasta recargar. Los mutadores llaman
// bumpMentions(); useMentions se suscribe y re-fetchea.
const listeners = new Set<() => void>();

export function bumpMentions(): void {
  listeners.forEach((l) => l());
}

export function subscribeMentions(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
