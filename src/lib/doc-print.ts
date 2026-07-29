// Imprimir un documento (y, por el mismo diálogo, "Guardar como PDF").
//
// El editor vive dentro del panel de artefactos: varios contenedores anidados, con
// `overflow` y anchos fijos. Eso hace que las dos recetas habituales fallen:
//
//   - `position: absolute` sobre el documento lo saca del flujo… y un elemento
//     posicionado en absoluto NO PAGINA: sólo sale la primera página. Fue el primer
//     intento y así se veía: una hoja y el texto cortado a la derecha.
//   - `visibility: hidden` en todo lo demás conserva el layout, así que el documento
//     sigue dentro de sus ancestros estrechos y con `overflow` → se recorta igual.
//
// Lo que sí funciona: sacar una COPIA del documento a la raíz del body, imprimir eso y
// quitarla. Al colgar de `<body>` no hereda ningún ancho ni recorte, y al ser estática
// pagina sola. Es una copia y no el nodo real porque el original lo gestiona React
// (BlockNote pinta con node views): moverlo y devolverlo sería pelearse con su árbol.

const ID = "gt-print-root";

export function imprimirDocumento(): boolean {
  const hoja = document.querySelector<HTMLElement>(".gt-doc article");
  if (!hoja) return false;

  document.getElementById(ID)?.remove();
  const caja = document.createElement("div");
  caja.id = ID;
  // Se clona con todo: en este punto el contenido del editor ya es HTML estático.
  const copia = hoja.cloneNode(true) as HTMLElement;
  // Los adornos del editor no son el documento.
  copia
    .querySelectorAll(".bn-side-menu, .bn-formatting-toolbar, .bn-slash-menu, [data-gt-marca]")
    .forEach((n) => n.remove());
  // Y la marca del cambio quirúrgico tampoco: es efímera de pantalla, no del papel.
  copia.querySelectorAll(".gt-cambio").forEach((n) => n.classList.remove("gt-cambio", "gt-cambio-fin"));
  caja.appendChild(copia);
  document.body.appendChild(caja);

  const limpiar = () => {
    document.getElementById(ID)?.remove();
    window.removeEventListener("afterprint", limpiar);
  };
  window.addEventListener("afterprint", limpiar);
  // Red por si `afterprint` no llega (pasa en algunos navegadores al cancelar).
  setTimeout(limpiar, 60_000);

  window.print();
  return true;
}
