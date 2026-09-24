import { describe, it, expect } from "vitest";
import { prMessageBody } from "../routes/api.internal.github-event";
import { extractAllGh } from "../lib/ebdoc";

const ev = { delivery: "d", repo: "Oswaldinho24k/fruteria", number: 12, title: "Preparar repo", url: "https://github.com/Oswaldinho24k/fruteria/pull/12", author: "ghosty-studio[bot]", by: "oswaldo", draft: false };

describe("aviso de PR en el room", () => {
  it("la tarjeta gt-gh que armamos la entiende el parser, con el estado correcto", () => {
    for (const [action, state] of [["merged", "merged"], ["closed", "closed"], ["opened", "open"]] as const) {
      const cards = extractAllGh(prMessageBody({ ...ev, action }));
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ kind: "pr", ref: "12", state, url: ev.url });
    }
  });
  it("dice quién mezcló", () => {
    expect(prMessageBody({ ...ev, action: "merged" })).toContain("🟣 **PR #12 mezclado** por @oswaldo");
  });
});
