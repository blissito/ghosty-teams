import { describe, expect, it } from "vitest";
import { autoMergeable, bumpLevel, isDependabot } from "./dependabot";

describe("bumpLevel", () => {
  it("lee el salto de versión del título", () => {
    expect(bumpLevel("Bump motion from 12.43.0 to 14.0.0")).toBe("major");
    expect(bumpLevel("Bump node-cron from 3.0.3 to 4.6.0")).toBe("major");
    expect(bumpLevel("Bump @types/node from 22.20.5 to 26.6.4 in /cli")).toBe("major");
    expect(bumpLevel("Bump vite from 5.1.0 to 5.4.2")).toBe("minor");
    expect(bumpLevel("Bump zod from 3.23.1 to 3.23.8")).toBe("patch");
  });
  it("en 0.x el minor rompe", () => {
    expect(bumpLevel("Bump citty from 0.1.6 to 0.2.2 in /cli")).toBe("major");
    expect(bumpLevel("Bump citty from 0.1.6 to 0.1.9")).toBe("patch");
  });
  it("los grupos se leen por su nombre", () => {
    expect(bumpLevel("Bump the minor-and-patch group with 7 updates")).toBe("minor");
    expect(bumpLevel("Bump the npm_and_yarn group across 2 directories with 3 updates")).toBe("unknown");
  });
  it("sólo minor y patch entran solos", () => {
    expect(autoMergeable("minor")).toBe(true);
    expect(autoMergeable("major")).toBe(false);
    expect(autoMergeable("unknown")).toBe(false);
  });
  it("reconoce al bot", () => {
    expect(isDependabot("dependabot[bot]")).toBe(true);
    expect(isDependabot("blissito")).toBe(false);
  });
});
