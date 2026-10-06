import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROLE_COLORS,
  factoryAvatarSvg,
  factoryAvatarUrl,
  isValidAvatarColor,
  keepRoleColor,
  parseFactoryAvatar,
  recolorRoleAvatar,
} from "./factory-avatar";

const GS = (h: string) => `https://www.ghosty.studio/avatars/factory-${h}.svg`;

describe("isValidAvatarColor", () => {
  it("sólo #rrggbb en minúsculas", () => {
    expect(isValidAvatarColor("#85ddcb")).toBe(true);
    for (const bad of ["#85DDCB", "85ddcb", "#85ddc", "#85ddcbb", "red", "#85ddcb\"/><script>", "", null, 123]) {
      expect(isValidAvatarColor(bad)).toBe(false);
    }
  });
});

describe("factoryAvatarSvg", () => {
  it("pinta el cuerpo con el color y deja lo fijo", () => {
    const svg = factoryAvatarSvg("#85ddcb");
    expect(svg).toContain('fill="#85ddcb"');
    expect(svg).toContain('fill="#191A20"');
    expect(svg).not.toContain("${");
  });
  it("rechaza un color que no valida (nada se inyecta en el SVG)", () => {
    expect(() => factoryAvatarSvg('#000000"/><script>')).toThrow();
  });
});

describe("parseFactoryAvatar", () => {
  it("lee la de gs con el color de casa y la nuestra con el suyo", () => {
    expect(parseFactoryAvatar(GS("plan"))).toEqual({ role: "plan", color: DEFAULT_ROLE_COLORS.plan });
    expect(parseFactoryAvatar(factoryAvatarUrl("check", "#f28b82"))).toEqual({ role: "check", color: "#f28b82" });
  });
  it("lo que no es flamita es null", () => {
    expect(parseFactoryAvatar("/api/attachment/abc")).toBeNull();
    expect(parseFactoryAvatar(GS("ghosty"))).toBeNull();
    expect(parseFactoryAvatar(null)).toBeNull();
  });
});

describe("recolorRoleAvatar (lo que se guarda en gc_agents.avatar)", () => {
  it("guarda la URL con el color y se vuelve a leer igual", () => {
    const url = recolorRoleAvatar("build", GS("build"), "#6fb5f2", GS("build"));
    expect(url).toBe("/api/factory-avatar/build.svg?c=6fb5f2");
    expect(parseFactoryAvatar(url)).toEqual({ role: "build", color: "#6fb5f2" });
  });
  it("el color de casa regresa a la URL de gs", () => {
    expect(recolorRoleAvatar("plan", factoryAvatarUrl("plan", "#f28b82"), DEFAULT_ROLE_COLORS.plan, GS("plan"))).toBe(GS("plan"));
  });
  it("no pisa un @plan ajeno ni acepta colores malos ni handles fuera de la fábrica", () => {
    expect(() => recolorRoleAvatar("plan", "/api/attachment/foto", "#6fb5f2", GS("plan"))).toThrow();
    expect(() => recolorRoleAvatar("plan", GS("build"), "#6fb5f2", GS("plan"))).toThrow();
    expect(() => recolorRoleAvatar("plan", GS("plan"), "#6FB5F2", GS("plan"))).toThrow();
    expect(() => recolorRoleAvatar("ghosty", GS("plan"), "#6fb5f2", GS("plan"))).toThrow();
  });
});

describe("keepRoleColor (repuntar un rol no pierde su color)", () => {
  it("conserva el color elegido", () => {
    expect(keepRoleColor("eval", factoryAvatarUrl("eval", "#85ddcb"), GS("eval"))).toBe("/api/factory-avatar/eval.svg?c=85ddcb");
  });
  it("sin color propio, o con otra cara, va la de gs", () => {
    expect(keepRoleColor("eval", GS("eval"), GS("eval"))).toBe(GS("eval"));
    expect(keepRoleColor("plan", "/api/attachment/foto", GS("plan"))).toBe(GS("plan"));
    expect(keepRoleColor("plan", null, GS("plan"))).toBe(GS("plan"));
  });
});
