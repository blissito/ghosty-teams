// Stack de modales abiertos. Cada modal registra un listener global de ESC, pero SOLO el
// modal de ARRIBA (el último abierto) responde — así ESC en un modal anidado (ej. editar
// agente sobre Ajustes) cierra únicamente ese, no también el de abajo.
//
// El stack vive en `window` (NO a nivel de módulo): si el bundler duplica este módulo
// entre chunks (c.$slug vs SettingsContent), un array de módulo daría DOS stacks → cada
// modal sería "top" del suyo → cerrarían ambos. window lo hace una sola verdad.
//
// Uso: useEffect(() => registerModalEsc(onClose), [onClose]);

function getStack(): symbol[] {
  const w = window as unknown as { __modalEscStack?: symbol[] };
  return (w.__modalEscStack ??= []);
}

export function registerModalEsc(onClose: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const id = Symbol("modal");
  getStack().push(id);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const stack = getStack();
    // No soy el modal superior → no cierro (solo el top cierra).
    if (stack[stack.length - 1] !== id) return;
    onClose();
  };
  window.addEventListener("keydown", onKey);
  return () => {
    const stack = getStack();
    const i = stack.indexOf(id);
    if (i !== -1) stack.splice(i, 1);
    window.removeEventListener("keydown", onKey);
  };
}
