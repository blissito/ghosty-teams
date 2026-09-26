import { describe, expect, it } from "vitest";
import { bubbleWithoutEbDoc, extractAdsCampaignCard, extractAdsProposalCard, extractAdsReportCard, stripAdsCards } from "./ebdoc";

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
