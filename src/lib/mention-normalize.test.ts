import { describe, expect, it } from "vitest";

import { normalizeMentions } from "./mention-normalize";

const M = [
  { handle: "ghosty", kind: "agent" as const },
  { handle: "ghosty-lite", kind: "agent" as const },
  { handle: "ana", kind: "agent" as const },
  { handle: "anabel", kind: "user" as const },
];

describe("normalizeMentions", () => {
  it("separa el handle pegado", () => {
    expect(normalizeMentions("@ghostyinformación en materia", M)).toBe("@ghosty información en materia");
  });
  it("no toca lo exacto ni a las personas ni los correos", () => {
    expect(normalizeMentions("@ghosty-lite y @anabel, foo@ghosty.com", M)).toBe("@ghosty-lite y @anabel, foo@ghosty.com");
  });
  it("deja en paz lo desconocido", () => {
    expect(normalizeMentions("@nadie hola", M)).toBe("@nadie hola");
  });
});
