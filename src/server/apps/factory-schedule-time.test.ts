import { describe, it, expect } from "vitest";
import { nextRunAt } from "./factory-schedule-time";

const TZ = "America/Mexico_City"; // UTC-6 sin horario de verano
// jue 24-sep-2026 10:00 local = 16:00 UTC
const thu10 = Date.UTC(2026, 8, 24, 16, 0) / 1000;
const local = (sec: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).format(new Date(sec * 1000));

describe("nextRunAt", () => {
  it("nocturna L–V: de jueves 10:00 pasa a viernes 02:00", () => {
    expect(local(nextRunAt("nightly", 2, true, TZ, thu10))).toMatch(/Fri.*2026-09-25.*02/);
  });
  it("nocturna L–V salta el fin de semana: de viernes 10:00 al lunes", () => {
    const fri10 = thu10 + 86_400;
    expect(local(nextRunAt("nightly", 2, true, TZ, fri10))).toMatch(/Mon.*2026-09-28.*02/);
  });
  it("nocturna diaria sí corre el sábado", () => {
    const fri10 = thu10 + 86_400;
    expect(local(nextRunAt("nightly", 2, false, TZ, fri10))).toMatch(/Sat.*2026-09-26/);
  });
  it("dependencias: el lunes siguiente a las 09:00", () => {
    expect(local(nextRunAt("deps", 9, false, TZ, thu10))).toMatch(/Mon.*2026-09-28.*09/);
  });
  it("mismo día si la hora aún no pasa", () => {
    expect(local(nextRunAt("nightly", 23, true, TZ, thu10))).toMatch(/Thu.*2026-09-24.*23/);
  });
});
