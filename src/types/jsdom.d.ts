// jsdom no publica tipos propios. Solo lo usamos en el server para obtener un DOMParser
// (ver src/server/artifact-dom.server.ts), así que declaramos la forma mínima en vez de
// sumar @types/jsdom como dependencia nueva del bake.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: unknown);
    readonly window: {
      DOMParser: new () => { parseFromString(s: string, t: string): Document };
    };
  }
}
