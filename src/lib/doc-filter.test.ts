import { describe, expect, it } from "vitest";
import type { TeamDocument } from "../server/documents";
import {
  EMPTY_DOC_FILTER,
  filterDocs,
  isDocFilterActive,
  kindCounts,
  toggleKind,
} from "./doc-filter";

const doc = (p: Partial<TeamDocument> & { key: string }): TeamDocument => ({
  source: "generated",
  kind: "doc",
  title: "Documento",
  channelId: 1,
  channelName: "General",
  channelSlug: "general",
  mine: false,
  messageId: 1,
  threadRootId: 1,
  createdAt: 1,
  ...p,
});

const DOCS: TeamDocument[] = [
  doc({ key: "a", title: "Cédula de inscripción — Liga San Antonio", mine: true }),
  doc({ key: "b", title: "CEDULAS.pdf (1).pdf", kind: "pdf", source: "uploaded", mine: true }),
  doc({ key: "c", title: "Perdix, la sombra que precede al vuelo", authorName: "Ana" }),
  doc({ key: "d", title: "Vinos mexicanos baratos", kind: "artifact", channelName: "Marketing" }),
];

describe("filterDocs", () => {
  it("sin filtro devuelve todo", () => {
    expect(filterDocs(DOCS, EMPTY_DOC_FILTER)).toHaveLength(4);
  });

  it("busca sin acentos ni mayúsculas", () => {
    // El caso real: la usuaria teclea "cedula" y el documento se llama "Cédula".
    const r = filterDocs(DOCS, { ...EMPTY_DOC_FILTER, q: "cedula" });
    expect(r.map((d) => d.key)).toEqual(["a", "b"]);
  });

  it("busca también por el nombre del room", () => {
    const r = filterDocs(DOCS, { ...EMPTY_DOC_FILTER, q: "marketing" });
    expect(r.map((d) => d.key)).toEqual(["d"]);
  });

  it("«Míos» usa el `mine` del servidor y no adivina", () => {
    const r = filterDocs(DOCS, { ...EMPTY_DOC_FILTER, mine: true });
    expect(r.map((d) => d.key)).toEqual(["a", "b"]);
  });

  it("kinds vacío significa TODOS, no ninguno", () => {
    expect(filterDocs(DOCS, { q: "", mine: false, kinds: [] })).toHaveLength(4);
  });

  it("los chips de tipo suman (OR), no restan", () => {
    const r = filterDocs(DOCS, { ...EMPTY_DOC_FILTER, kinds: ["pdf", "artifact"] });
    expect(r.map((d) => d.key)).toEqual(["b", "d"]);
  });

  it("combina los tres ejes", () => {
    const r = filterDocs(DOCS, { q: "cedula", mine: true, kinds: ["pdf"] });
    expect(r.map((d) => d.key)).toEqual(["b"]);
  });
});

describe("kindCounts", () => {
  it("sólo cuenta los tipos presentes", () => {
    const c = kindCounts(DOCS);
    expect(c.get("doc")).toBe(2);
    expect(c.get("pdf")).toBe(1);
    // Un chip «Hoja · 0» invita a un clic que vacía la lista: no debe existir.
    expect(c.has("sheet")).toBe(false);
  });
});

describe("toggleKind / isDocFilterActive", () => {
  it("un clic pone y otro quita", () => {
    const on = toggleKind(EMPTY_DOC_FILTER, "pdf");
    expect(on.kinds).toEqual(["pdf"]);
    expect(toggleKind(on, "pdf").kinds).toEqual([]);
  });

  it("detecta filtro activo en los tres ejes", () => {
    expect(isDocFilterActive(EMPTY_DOC_FILTER)).toBe(false);
    // Sólo espacios no es filtrar: el encabezado no debe pasar a «N de M» por eso.
    expect(isDocFilterActive({ ...EMPTY_DOC_FILTER, q: "   " })).toBe(false);
    expect(isDocFilterActive({ ...EMPTY_DOC_FILTER, q: "x" })).toBe(true);
    expect(isDocFilterActive({ ...EMPTY_DOC_FILTER, mine: true })).toBe(true);
    expect(isDocFilterActive({ ...EMPTY_DOC_FILTER, kinds: ["pdf"] })).toBe(true);
  });
});
