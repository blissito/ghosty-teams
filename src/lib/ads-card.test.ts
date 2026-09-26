import { describe, expect, it } from "vitest";
import { bubbleWithoutEbDoc, extractAdsCampaignCard, extractAdsProposalCard, extractAdsReportCard, stripAdsCards } from "./ebdoc";
import { campaignLink, compactSummary, parseVersionLine, versionLine } from "./ads-links";

describe("tarjetas de Ghosty Ads", () => {
  it("saca el id de cada fence", () => {
    expect(extractAdsProposalCard('```gt-ads-proposal\n{"campaignId":7}\n```')).toEqual({ campaignId: 7 });
    expect(extractAdsCampaignCard('```gt-ads-campaign\n{"campaignId":12}\n```')).toEqual({ campaignId: 12 });
    expect(extractAdsReportCard('```gt-ads-report\n{"reportId":3}\n```')).toEqual({ reportId: 3 });
  });

  it("no confunde un fence con otro", () => {
    expect(extractAdsCampaignCard('```gt-ads-proposal\n{"campaignId":7}\n```')).toBeNull();
    expect(extractAdsProposalCard('```gt-ads-campaign\n{"campaignId":7}\n```')).toBeNull();
  });

  it("un id raro o un fence a medias no pinta tarjeta", () => {
    expect(extractAdsProposalCard('```gt-ads-proposal\n{"campaignId":"x"}\n```')).toBeNull();
    expect(extractAdsProposalCard('```gt-ads-proposal\n{"campaignId":-1}\n```')).toBeNull();
    expect(extractAdsProposalCard('```gt-ads-proposal\n{"campaignId":7}')).toBeNull();
    expect(extractAdsReportCard('```gt-ads-report\n{items:[]}\n```')).toBeNull();
  });

  it("el JSON del fence no queda pintado en la burbuja; la prosa sí", () => {
    const body = 'Lista la propuesta.\n\n```gt-ads-proposal\n{"campaignId":7}\n```';
    expect(stripAdsCards(body)).toBe("Lista la propuesta.");
    expect(bubbleWithoutEbDoc(body)).not.toContain("campaignId");
    expect(stripAdsCards("sin tarjeta")).toBe("sin tarjeta");
  });
});

describe("líneas «✏️ … → vN» (link a la versión)", () => {
  it("la línea que publica la plataforma se mapea a su campaña y versión", () => {
    expect(parseVersionLine(versionLine("@ads", null, 4, 3))).toEqual({ text: "@ads ajustó la propuesta #4", campaignId: 4, version: 3 });
    expect(parseVersionLine(versionLine("Blissmo", "el copy y el botón", 12, 5))).toEqual({
      text: "Blissmo cambió el copy y el botón de la propuesta #12",
      campaignId: 12,
      version: 5,
    });
  });

  it("las líneas viejas sin #N dan la versión y la campaña se busca por el hilo", () => {
    expect(parseVersionLine("✏️ @ads ajustó la propuesta → v3")).toEqual({ text: "@ads ajustó la propuesta", campaignId: null, version: 3 });
    expect(parseVersionLine("✏️ blissmo cambió el copy → v4")).toMatchObject({ campaignId: null, version: 4 });
  });

  it("otra cosa no es línea de versión", () => {
    expect(parseVersionLine("Listo, ya quedó la v3")).toBeNull();
    expect(parseVersionLine("✏️ algo → v0")).toBeNull();
    expect(parseVersionLine("✏️ @ads ajustó la propuesta #4 → v3\n\notro párrafo")).toBeNull();
  });
});

describe("tarjeta compacta y link directo", () => {
  it("el fence de la propuesta es el que se pinta compacto", () => {
    expect(extractAdsProposalCard('```gt-ads-proposal\n{"campaignId":4}\n```')).toEqual({ campaignId: 4 });
  });

  it("resumen de una línea", () => {
    expect(compactSummary({ campaignId: 4, proposal: true, version: 3, dailyBudget: 50, endTime: "2026-10-27T23:59:00-06:00" })).toBe(
      "Propuesta #4 · v3 · $50/día · hasta 27 oct",
    );
    expect(compactSummary({ campaignId: 7, proposal: false, version: 1, dailyBudget: 1500, endTime: null })).toBe("Campaña #7 · v1 · $1,500/día");
  });

  it("link para compartir", () => {
    expect(campaignLink("anuncios", 812, 4)).toBe("/c/anuncios?thread=812&campaign=4");
    expect(campaignLink("anuncios", null, 4)).toBe("/c/anuncios?campaign=4");
  });
});
