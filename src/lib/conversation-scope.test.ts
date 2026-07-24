import { describe, expect, it } from "vitest";
import { belongsToOpenConversation } from "./conversation-scope";

describe("belongsToOpenConversation", () => {
  it("acepta el mensaje del room abierto", () => {
    expect(belongsToOpenConversation({ channel_id: 7, dm_id: null }, null, 7)).toBe(true);
  });

  it("rechaza el mensaje de OTRO room", () => {
    expect(belongsToOpenConversation({ channel_id: 9, dm_id: null }, null, 7)).toBe(false);
  });

  it("estando en un DM, rechaza el mensaje de un room (el caso reportado)", () => {
    expect(belongsToOpenConversation({ channel_id: 7, dm_id: null }, 42, 7)).toBe(false);
  });

  it("estando en un DM, acepta el de ESE DM y rechaza el de otro", () => {
    expect(belongsToOpenConversation({ channel_id: null, dm_id: 42 }, 42, 7)).toBe(true);
    expect(belongsToOpenConversation({ channel_id: null, dm_id: 43 }, 42, 7)).toBe(false);
  });

  it("sin el mensaje en cache no bloquea", () => {
    expect(belongsToOpenConversation(undefined, null, 7)).toBe(true);
  });
});
