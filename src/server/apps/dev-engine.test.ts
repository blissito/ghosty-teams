import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { devRunsSignature } from "./dev-engine.server";

describe("puerta de Teams al motor de gs", () => {
  it("firma ts.slug.body como `internal.dev-runs.$slug` de gs", () => {
    const body = JSON.stringify({ op: "engine" });
    const expected = crypto.createHmac("sha256", "s3cr3t").update(`1700000000.business.${body}`).digest("hex");
    expect(devRunsSignature("s3cr3t", 1700000000, "business", body)).toBe(expected);
  });
});
