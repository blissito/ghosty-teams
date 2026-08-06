import { describe, expect, it } from "vitest";
import { bubbleWithoutEbDoc, extractPr, stripPr } from "./ebdoc";

const card = (extra = "") => `Revisé el PR. Se ve bien.

\`\`\`gt-pr
{"repo":"acme/api","number":412,"title":"fix(mailer)","author":"lupita","additions":31,"deletions":4,"files":3,"checks":"FAILURE","url":"https://github.com/acme/api/pull/412","verdict":"CI roja por otro test."}
\`\`\`${extra}`;

describe("gt-pr", () => {
  it("saca los datos y normaliza checks a minúsculas", () => {
    const p = extractPr(card())!;
    expect(p.repo).toBe("acme/api");
    expect(p.number).toBe(412);
    expect(p.checks).toBe("failure");
    expect(p.files).toBe(3);
  });

  it("acepta el CERO en los conteos — un PR que sólo borra tiene additions 0", () => {
    const p = extractPr('```gt-pr\n{"repo":"a/b","number":1,"additions":0,"deletions":9}\n```')!;
    expect(p.additions).toBe(0);
    expect(p.deletions).toBe(9);
  });

  it("sin repo o sin número NO pinta tarjeta: no habría acción posible", () => {
    expect(extractPr('```gt-pr\n{"number":5}\n```')).toBeNull();
    expect(extractPr('```gt-pr\n{"repo":"a/b"}\n```')).toBeNull();
  });

  it("no pinta media tarjeta si el fence sigue abierto", () => {
    expect(extractPr('```gt-pr\n{"repo":"a/b","number":1')).toBeNull();
  });

  it("inventa la url sólo cuando falta, a partir de repo y número", () => {
    expect(extractPr('```gt-pr\n{"repo":"a/b","number":7}\n```')!.url).toBe("https://github.com/a/b/pull/7");
  });

  it("descarta un campo de tipo equivocado en vez de reventar la tarjeta entera", () => {
    const p = extractPr('```gt-pr\n{"repo":"a/b","number":1,"additions":"muchos","title":5}\n```')!;
    expect(p.additions).toBeNull();
    expect(p.title).toBe("");
  });

  it("el JSON no llega al bubble, pero la reseña SÍ se queda", () => {
    const b = bubbleWithoutEbDoc(card());
    expect(b).toContain("Revisé el PR");
    expect(b).not.toContain("gt-pr");
    expect(b).not.toContain("acme/api");
  });

  it("stripPr conserva lo de antes y lo de después del fence", () => {
    expect(stripPr(card("\n\nAvísame."))).toBe("Revisé el PR. Se ve bien.\n\nAvísame.");
  });

  it("un body sin fence pasa intacto", () => {
    expect(stripPr("hola")).toBe("hola");
    expect(extractPr("hola")).toBeNull();
  });
});
