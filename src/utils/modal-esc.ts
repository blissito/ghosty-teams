// Stack de modales abiertos. Cada modal registra un listener global de ESC, pero SOLO el
// modal de ARRIBA (el último abierto) responde — así ESC en un modal anidado (ej. editar
// agente sobre Ajustes) cierra únicamente ese, no también el de abajo.
//
// Uso: useEffect(() => registerModalEsc(onClose), [onClose]);
const stack: symbol[] = [];

export function registerModalEsc(onClose: () => void): () => void {
  const id = Symbol("modal");
  stack.push(id);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // No soy el modal superior → no cierro (deja que solo el top cierre).
    if (stack[stack.length - 1] !== id) return;
    onClose();
  };
  window.addEventListener("keydown", onKey);
  return () => {
    const i = stack.indexOf(id);
    if (i !== -1) stack.splice(i, 1);
    window.removeEventListener("keydown", onKey);
  };
}
