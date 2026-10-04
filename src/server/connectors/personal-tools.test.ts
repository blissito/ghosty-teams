import { describe, expect, it } from "vitest";
import { isPersonalClaim, personalToolAllowed } from "./personal-tools.server";
import { isPersonalNs, withNamespace } from "../tenant.server";

describe("modo personal (sin espacio de Teams)", () => {
  it("el ns personal sólo vale para su propio sub", () => {
    expect(isPersonalClaim("u1", "personal:u1")).toBe(true);
    expect(isPersonalClaim("u1", "personal:u2")).toBe(false);
    expect(isPersonalClaim("u1", "ws_acme")).toBe(false);
    expect(isPersonalClaim("u1", null)).toBe(false);
  });

  it("sólo tools de los 5 conectores y nunca las de canal", () => {
    expect(personalToolAllowed("github_list_repos")).toBe(true);
    expect(personalToolAllowed("odoo_search_read")).toBe(true);
    expect(personalToolAllowed("github_watch_pr")).toBe(false);
    expect(personalToolAllowed("sentry_alerts_enable")).toBe(false);
    expect(personalToolAllowed("task_create")).toBe(false);
    expect(personalToolAllowed("drive_leer")).toBe(false);
    expect(personalToolAllowed("chat_post")).toBe(false);
  });

  it("ninguna query llega a sqld con un ns personal", async () => {
    expect(isPersonalNs("personal:u1")).toBe(true);
    const { dbq } = await import("../../dbq.server");
    await expect(withNamespace("personal:u1", () => dbq("SELECT 1"))).rejects.toThrow(/modo personal/);
  });
});
