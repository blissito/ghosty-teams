// La tarjeta simple de GitHub y el multi-fence de la de PR.
//
// Lo que se prueba aquí es sobre todo lo que NO debe pintarse: una tarjeta a medias, un
// enlace que no es https, y un fence que se quede sin recortar y salga como JSON en el chat.
import { describe, expect, it } from "vitest";

import { bubbleWithoutEbDoc, extractAllGh, extractAllPr, extractPr, stripGh } from "./ebdoc";

const gh = (o: Record<string, unknown>) => "```gt-gh\n" + JSON.stringify(o) + "\n```";
const ok = {
  kind: "issue",
  repo: "blissito/easybits",
  ref: 167,
  title: "Soportar ACP en la flota",
  url: "https://github.com/blissito/easybits/issues/167",
  state: "open",
};

describe("la tarjeta simple", () => {
  it("acepta un issue y normaliza el número a texto", () => {
    const [c] = extractAllGh(`Listo.\n\n${gh(ok)}`);
    expect(c).toMatchObject({ kind: "issue", repo: "blissito/easybits", ref: "167", state: "open" });
  });

  it("descarta lo que no se puede enseñar ni abrir", () => {
    expect(extractAllGh(gh({ ...ok, repo: "" }))).toHaveLength(0);
    expect(extractAllGh(gh({ ...ok, ref: "" }))).toHaveLength(0);
    expect(extractAllGh(gh({ ...ok, url: "" }))).toHaveLength(0);
    expect(extractAllGh(gh({ ...ok, kind: "epica" }))).toHaveLength(0);
  });

  it("🔴 un enlace que no es https no se pinta", () => {
    // La plataforma pinta este enlace con datos que escribe un modelo: es exactamente el
    // sitio donde un `javascript:` acaba siendo clicable.
    expect(extractAllGh(gh({ ...ok, url: "javascript:alert(1)" }))).toHaveLength(0);
    expect(extractAllGh(gh({ ...ok, url: "http://github.com/x/y/issues/1" }))).toHaveLength(0);
  });

  it("un fence a medio llegar no pinta media tarjeta", () => {
    expect(extractAllGh("```gt-gh\n{\"kind\":\"issue\"")).toHaveLength(0);
  });

  it("dos issues en un turno son dos tarjetas, y ninguna queda como JSON en la burbuja", () => {
    const body = `Abrí los dos.\n\n${gh(ok)}\n\n${gh({ ...ok, ref: 168, title: "Otro" })}`;
    expect(extractAllGh(body)).toHaveLength(2);
    expect(stripGh(body)).toBe("Abrí los dos.");
    expect(bubbleWithoutEbDoc(body)).not.toContain("gt-gh");
    expect(bubbleWithoutEbDoc(body)).not.toContain("github.com");
  });
});

describe("varias tarjetas de PR en un turno", () => {
  const pr = (n: number) =>
    "```gt-pr\n" +
    JSON.stringify({ repo: "blissito/easybits", number: n, title: `PR ${n}`, url: `https://github.com/x/y/pull/${n}` }) +
    "\n```";

  it("se pintan las dos y el body no conserva ningún fence", () => {
    // Antes se leía sólo la primera —`match` sin flag `g`— y la segunda salía CRUDA en el
    // chat: el fence sobrevivía en el body y Markdown lo pintaba como bloque de código.
    const body = `Revisé los dos.\n\n${pr(11)}\n\n${pr(12)}`;
    expect(extractAllPr(body).map((p) => p.number)).toEqual([11, 12]);
    expect(bubbleWithoutEbDoc(body)).toBe("Revisé los dos.");
  });

  it("`extractPr` sigue devolviendo la primera, para los call-sites de siempre", () => {
    expect(extractPr(`${pr(11)}\n${pr(12)}`)?.number).toBe(11);
    expect(extractPr("sin fence")).toBeNull();
  });
});
