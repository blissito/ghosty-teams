// ── "El panel se está cerrando", dicho en el DOM ─────────────────────────────
//
// Los controles flotantes del documento (lectura en voz alta, ortografía) van `fixed`
// sobre el rect del panel, así que mientras su ancho se anima hasta cero se quedan
// clavados en su sitio con el documento yéndose por debajo: medio segundo de desfase justo
// en el gesto de cerrar.
//
// ⚠️ **Por qué no basta con un prop.** Al cerrar, el panel sale con una animación de
// salida y React CONGELA ese subárbol con las props que tenía: dentro de él, cualquier
// `cerrando` se queda en `false` para siempre porque ya no se re-renderiza. Un ResizeObserver
// sí llega —los efectos siguen vivos— pero llega tarde para lo que el ojo nota.
//
// Un atributo en `<body>` no depende de que React re-renderice nada, y lo puede leer
// cualquiera que siga montado. De ahí esta rendija.

const MARCA = "artifactClosing";

/** Lo llama quien cierra el panel, antes de tirar el estado. */
export function marcarCierre() {
  if (typeof document !== "undefined") document.body.dataset[MARCA] = "1";
}

/** Lo llama quien abre: la marca es de UN cierre, no un estado pegajoso. */
export function limpiarCierre() {
  if (typeof document !== "undefined") delete document.body.dataset[MARCA];
}

export function estaCerrando(): boolean {
  return typeof document !== "undefined" && document.body.dataset[MARCA] === "1";
}

/** Avisa cuando la marca cambia. Devuelve la función para dejar de mirar. */
export function observarCierre(cb: (cerrando: boolean) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const obs = new MutationObserver(() => cb(estaCerrando()));
  obs.observe(document.body, { attributes: true, attributeFilter: ["data-artifact-closing"] });
  return () => obs.disconnect();
}
