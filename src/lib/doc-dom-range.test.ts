// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { rangoEnBloque } from "./doc-dom-range";

// El subrayado no aparecía y no había forma de saber por qué mirando la pantalla. Esto
// reproduce el DOM que monta BlockNote —con su `bn-block-outer` / `bn-block` / `bn-block-
// content`, y con bloques ANIDADOS dentro del mismo `[data-id]`— para poder medirlo aquí
// en vez de a base de capturas.

function montar(html: string): HTMLElement {
  document.body.innerHTML = `<div class="gt-doc">${html}</div>`;
  return document.querySelector<HTMLElement>("[data-id]")!;
}

/** Un párrafo como lo pinta BlockNote 0.51. */
const parrafo = (texto: string, id = "b1") =>
  `<div class="bn-block-outer" data-node-type="blockOuter">
     <div class="bn-block" data-id="${id}" data-node-type="blockContainer">
       <div class="bn-block-content" data-content-type="paragraph">
         <p class="bn-inline-content">${texto}</p>
       </div>
     </div>
   </div>`;

describe("rangoEnBloque", () => {
  it("encuentra la palabra en un párrafo simple", () => {
    const b = montar(parrafo("Esto es una prueva de ortografia"));
    const r = rangoEnBloque(b, 12, 6); // "prueva"
    expect(r).not.toBeNull();
    expect(r!.toString()).toBe("prueva");
  });

  it("atraviesa runs con formato", () => {
    const b = montar(parrafo("El <strong>artifice</strong> fabrica"));
    const r = rangoEnBloque(b, 3, 8); // "artifice"
    expect(r?.toString()).toBe("artifice");
  });

  it("NO cuenta el texto de los bloques anidados", () => {
    // Un elemento de lista con hijos: BlockNote los mete DENTRO del mismo `.bn-block`.
    const b = montar(
      `<div class="bn-block-outer">
         <div class="bn-block" data-id="padre">
           <div class="bn-block-content"><p class="bn-inline-content">Texto del padre</p></div>
           <div class="bn-block-group">${parrafo("hijo con prueva dentro", "hijo")}</div>
         </div>
       </div>`,
    );
    // El offset 0..5 del PADRE es "Texto", no puede irse al hijo.
    expect(rangoEnBloque(b, 0, 5)?.toString()).toBe("Texto");
    // Y pedir más allá de su propio texto no devuelve nada del hijo.
    expect(rangoEnBloque(b, 100, 4)).toBeNull();
  });

  it("respeta los espacios colapsados igual que blockTextMapped", () => {
    const b = montar(parrafo("uno    dos"));
    // En el texto normalizado, "dos" empieza en 4.
    expect(rangoEnBloque(b, 4, 3)?.toString()).toBe("dos");
  });

  it("un offset fuera de rango devuelve null en vez de señalar cualquier cosa", () => {
    const b = montar(parrafo("corto"));
    expect(rangoEnBloque(b, 10, 3)).toBeNull();
    expect(rangoEnBloque(b, 0, 0)).toBeNull();
  });
});
