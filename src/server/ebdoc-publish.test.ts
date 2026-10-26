import { describe, it, expect, vi } from "vitest";

const publishArtifactVersion = vi.fn(async (_: unknown) => ({ imagesFailed: [] as string[] }));
vi.mock("./artifacts", () => ({ publishArtifactVersion, imageGapNotice: () => "" }));

import { publishEbDocFromReply } from "./ebdoc-publish.server";

const base = { messageId: 7, ownerSub: null, currentDocId: null, currentDoc: null, setPointer: async () => {}, notify: () => {} };

describe("publishEbDocFromReply", () => {
  it("publica el eb-doc cerrado y deja la burbuja sin el fence", async () => {
    const reply = "Listo, aquí va.\n\n```eb-doc\n# Mapeo DIVI\n\nTexto del documento.\n```";
    const body = await publishEbDocFromReply({ ...base, reply });
    expect(publishArtifactVersion).toHaveBeenCalledOnce();
    expect(body).not.toContain("```eb-doc");
  });

  it("sin documento no publica nada", async () => {
    publishArtifactVersion.mockClear();
    expect(await publishEbDocFromReply({ ...base, reply: "Sólo texto." })).toBeNull();
    expect(publishArtifactVersion).not.toHaveBeenCalled();
  });
});
