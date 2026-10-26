import { describe, expect, it } from "vitest";
import { cronToSchedule, scheduleToCron } from "./factory-repo-schedule";
import { parseCron } from "../automations/maintenance.server";

describe("horario por repo: día + hora ⇄ cron", () => {
  it("ida y vuelta para cada día de la pantalla", () => {
    for (const day of ["1-5", "*", "0", "1", "6"] as const) {
      const cron = scheduleToCron(day, 7);
      expect(parseCron(cron)).not.toBeNull();
      expect(cronToSchedule(cron)).toEqual({ day, hour: 7 });
    }
  });

  it("la hora se acota y un cron a la medida no se pinta como día+hora", () => {
    expect(scheduleToCron("1", 30)).toBe("0 23 * * 1");
    expect(cronToSchedule("*/15 * * * *")).toBeNull();
    expect(cronToSchedule("30 9 * * 1")).toBeNull();
    expect(cronToSchedule("0 9 * * 1,3")).toBeNull();
  });
});
