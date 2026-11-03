import { describe, expect, it } from "vitest";
import { trackStick } from "./stick-to-bottom";

// Scroller falso: sin jsdom, basta con alto, posición y listeners.
function fakeScroller(scrollHeight = 2000, clientHeight = 500) {
  const ls = new Map<string, (e: any) => void>();
  const el = {
    scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight,
    addEventListener: (t: string, f: (e: any) => void) => ls.set(t, f),
    removeEventListener: (t: string) => ls.delete(t),
  };
  const fire = (t: string, e: any = {}) => ls.get(t)?.(e);
  const scrollTo = (top: number) => { el.scrollTop = top; fire("scroll"); };
  return { el, fire, scrollTo, ls };
}

describe("pegado al fondo (patrón use-stick-to-bottom)", () => {
  it("un paso de 10 px de rueda hacia arriba despega, aunque siga «cerca» del fondo", () => {
    const { el, fire, scrollTo } = fakeScroller();
    const stuck = { current: true };
    trackStick(el as any, stuck);
    fire("wheel", { deltaY: -10 });
    scrollTo(el.scrollTop - 10);
    expect(stuck.current).toBe(false);
  });

  it("el contenido que crece no lo vuelve a pegar ni lo despega", () => {
    const { el, fire } = fakeScroller();
    const stuck = { current: false };
    trackStick(el as any, stuck);
    el.scrollTop = 1000;
    fire("scroll");
    el.scrollHeight += 300; // llegó un token
    fire("scroll");
    expect(stuck.current).toBe(false);
  });

  it("bajar hasta el fondo real (≤ 4 px) vuelve a pegar", () => {
    const { el, scrollTo } = fakeScroller();
    const stuck = { current: false };
    trackStick(el as any, stuck);
    scrollTo(1000);
    expect(stuck.current).toBe(false);
    scrollTo(el.scrollHeight - el.clientHeight - 3);
    expect(stuck.current).toBe(true);
  });

  it("dedo hacia abajo (contenido hacia arriba) y ArrowUp despegan; rueda hacia abajo no", () => {
    const stuck = { current: true };
    const a = fakeScroller();
    trackStick(a.el as any, stuck);
    a.fire("wheel", { deltaY: 40 });
    expect(stuck.current).toBe(true);
    a.fire("touchstart", { touches: [{ clientY: 100 }] });
    a.fire("touchmove", { touches: [{ clientY: 120 }] });
    expect(stuck.current).toBe(false);
    stuck.current = true;
    a.fire("keydown", { key: "ArrowUp" });
    expect(stuck.current).toBe(false);
  });

  it("la limpieza quita los listeners", () => {
    const { el, ls } = fakeScroller();
    const off = trackStick(el as any, { current: true });
    off();
    expect(ls.size).toBe(0);
  });
});
