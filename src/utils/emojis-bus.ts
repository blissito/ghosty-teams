// Bus mínimo para invalidar el cache de emojis custom cuando cambian: agregar/borrar
// ocurre en Ajustes → Emojis, pero el picker y el render de mensajes (useEmojis) viven
// con su propio cache de módulo → sin esto un emoji recién agregado no se resolvía
// (`:name:` salía literal) hasta recargar. Los mutadores llaman bumpEmojis(); useEmojis
// se suscribe y re-fetchea.
const listeners = new Set<() => void>();

export function bumpEmojis(): void {
  listeners.forEach((l) => l());
}

export function subscribeEmojis(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
