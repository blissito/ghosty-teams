import { describe, expect, it } from "vitest";
import { mergeFeed } from "./DevThreadFeed";

describe("hilo del pendiente", () => {
  it("intercala Teams y gs por hora; lo de gs sin hora va al final", () => {
    const real = [{ id: 1, created_at: 100 }, { id: 2, created_at: 300 }] as never[];
    const dev = [
      { seq: 1, role: "writer" as const, text: "a", at: new Date(200_000).toISOString(), by: null },
      { seq: 2, role: "writer" as const, text: "b", at: null, by: null },
    ];
    const out = mergeFeed(real, dev).map((i) => (i.kind === "real" ? `r${i.m.id}` : `d${i.d.seq}`));
    expect(out).toEqual(["r1", "d1", "r2", "d2"]);
  });
});

import { ebFilesAsAttachments } from "./DevThreadFeed";
describe("archivos del escritor", () => {
  it("eb-file de nuestro bucket → adjunto con su llave; texto sin bloque", () => {
    const txt = 'Aquí:\n```eb-file\n{"url":"https://t3.storage.dev/ghosty-teams/u/a/b/x.png?X-Amz=1"}\n```\nfin';
    expect(ebFilesAsAttachments(txt, 3)).toEqual([{ id: -300, file_id: "u/a/b/x.png", mime: "image/png", size: null, name: "x.png" }]);
  });
});
