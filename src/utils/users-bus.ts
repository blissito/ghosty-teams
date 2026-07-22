// Bus mínimo para refrescar el directorio de miembros (mapa vivo sub→perfil) cuando
// alguien edita su perfil (nombre/avatar/status…). El mapa resuelve avatars en TODOS
// lados (mensajes viejos, sidebar) + alimenta el drawer. Los mutadores llaman bumpUsers().
const listeners = new Set<() => void>();

export function bumpUsers(): void {
  listeners.forEach((l) => l());
}

export function subscribeUsers(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
