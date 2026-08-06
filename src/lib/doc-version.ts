// El pin de versión, del lado del cliente: una sola función, y existe por un bug concreto.
//
// `resolveExportDoc` cae a la ÚLTIMA versión EN SILENCIO cuando el `?v` pedido no resuelve.
// Esa caída es deliberada —un 404 a media narración es peor que leer el texto vivo— pero su
// silencio es lo que escondió durante semanas que la lectura en voz alta y el corrector
// estuvieran mirando el OTRO documento del hilo: dos ```eb-doc``` seguidos comparten
// `documentId`, así que "la última" no era la que se veía en pantalla.
//
// Los endpoints devuelven `X-Doc-Version` con la fila que sirvieron de verdad. Si no
// coincide con la pedida, que se vea en la consola en vez de sonar como un documento
// equivocado.
export function avisarVersion(r: Response, pedida: string | number | null | undefined) {
  const servida = r.headers.get("X-Doc-Version");
  if (!servida || pedida == null || pedida === "") return;
  if (String(pedida) !== servida) {
    console.warn(`[doc] se pidió la versión ${pedida} y el servidor sirvió la ${servida}`);
  }
}
