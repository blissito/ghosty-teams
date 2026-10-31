import { describe, expect, it } from "vitest";
import { autoMergeable, bumpLevel, isDependabot, parseUpdatedDependencies, touchesRuntime } from "./dependabot";

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

// Mensaje real del commit de Dependabot (lo que lee `dependabot/fetch-metadata`).
const MSG = `Bump the dev group with 2 updates

---
updated-dependencies:
- dependency-name: typescript
  dependency-version: 6.0.0
  dependency-type: direct:development
  update-type: version-update:semver-major
- dependency-name: "@types/node"
  dependency-version: 26.0.0
  dependency-type: direct:development
  update-type: version-update:semver-major
...

Signed-off-by: dependabot[bot] <support@github.com>`;

describe("parseUpdatedDependencies / touchesRuntime", () => {
  it("lee nombre y tipo de cada dependencia", () => {
    expect(parseUpdatedDependencies(MSG)).toEqual([
      { name: "typescript", type: "direct:development" },
      { name: "@types/node", type: "direct:development" },
    ]);
  });
  it("sólo desarrollo no toca runtime", () => {
    expect(touchesRuntime("dependabot/npm_and_yarn/dev-abc", parseUpdatedDependencies(MSG))).toBe(false);
  });
  it("una de producción sí", () => {
    const prod = MSG.replace("direct:development", "direct:production");
    expect(touchesRuntime("dependabot/npm_and_yarn/x", parseUpdatedDependencies(prod))).toBe(true);
  });
  it("las acciones de GitHub corren en el CI, no en prod", () => {
    expect(touchesRuntime("dependabot/github_actions/actions/checkout-5", [])).toBe(false);
  });
  it("sin metadatos se asume que sí", () => {
    expect(touchesRuntime("dependabot/npm_and_yarn/x", parseUpdatedDependencies("Bump x from 1 to 2"))).toBe(true);
  });
});
