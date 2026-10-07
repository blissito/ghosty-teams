import { describe, expect, it, vi } from "vitest";

vi.mock("../../dbq.server", () => ({ dbq: vi.fn() }));
const { parseReceivePackCommands, refUpdateDenial } = await import("./factory-git.server");

const A = "a".repeat(40), B = "b".repeat(40), Z = "0".repeat(40);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const enc = (s: string) => new TextEncoder().encode(s);

describe("comandos de receive-pack", () => {
  it("lee los comandos hasta el flush y dice dónde empieza el pack", () => {
    const head = pkt(`${A} ${B} refs/heads/build/x\0report-status side-band-64k\n`) + "0000";
    const r = parseReceivePackCommands(enc(head + "PACK..."));
    expect(r?.cmds).toEqual([{ old: A, new: B, ref: "refs/heads/build/x" }]);
    expect(r?.end).toBe(head.length);
  });
  it("sin flush todavía: null (falta leer más)", () => {
    expect(parseReceivePackCommands(enc(pkt(`${A} ${B} refs/heads/x\n`)))).toBeNull();
    expect(parseReceivePackCommands(enc(pkt(`${A} ${B} refs/heads/x\n`).slice(0, 20)))).toBeNull();
  });
  it("basura: error", () => {
    expect(() => parseReceivePackCommands(enc("zzzz"))).toThrow();
  });
});

describe("qué push se deja pasar", () => {
  const o = { defaultBranch: "main", lockedBranch: null };
  it("una rama nueva del pedido: sí", () => {
    expect(refUpdateDenial([{ old: Z, new: B, ref: "refs/heads/build/x" }], o)).toBeNull();
  });
  it("la principal, borrar, tags y varias ramas: no", () => {
    expect(refUpdateDenial([{ old: A, new: B, ref: "refs/heads/main" }], o)).toMatch(/principal/);
    expect(refUpdateDenial([{ old: A, new: Z, ref: "refs/heads/build/x" }], o)).toMatch(/borran/);
    expect(refUpdateDenial([{ old: Z, new: B, ref: "refs/tags/v1" }], o)).toMatch(/solo ramas/);
    expect(refUpdateDenial([{ old: Z, new: B, ref: "refs/heads/a" }, { old: Z, new: B, ref: "refs/heads/b" }], o)).toMatch(/una rama/);
  });
  it("con rama fija, sólo ésa", () => {
    const locked = { defaultBranch: "main", lockedBranch: "build/x" };
    expect(refUpdateDenial([{ old: A, new: B, ref: "refs/heads/build/x" }], locked)).toBeNull();
    expect(refUpdateDenial([{ old: Z, new: B, ref: "refs/heads/otra" }], locked)).toMatch(/build\/x/);
  });
});
