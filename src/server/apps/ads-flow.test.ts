import { describe, it, expect } from "vitest";
import { nextAdsStatus, inMeta } from "./ads-flow";
import {
  applyEdit,
  attachmentIdOf,
  campaignDays,
  changedFields,
  CTA_TYPES,
  describeChanges,
  endTimeFromDate,
  funnelOf,
  maxTotal,
  parseProposal,
  parseTargeting,
  reportDigest,
  submitMode,
  liveChangeDiff,
  parseLiveChange,
  parseReview,
  reviewNotice,
  tokenWarning,
  mergeSubmit,
  summarizeProposal,
  removeZone,
  zoneRemovable,
} from "./ads-proposal";
import { nextReportAt, normalizeHours } from "./ads-report-time";

describe("nextAdsStatus", () => {
  it("camino feliz: propuesta → creando → pausa ⇄ activa → terminada", () => {
    expect(nextAdsStatus("proposal", "create")).toBe("creating");
    expect(nextAdsStatus("creating", "created")).toBe("paused");
    expect(nextAdsStatus("paused", "activate")).toBe("active");
    expect(nextAdsStatus("active", "pause")).toBe("paused");
    expect(nextAdsStatus("active", "end")).toBe("ended");
    expect(nextAdsStatus("paused", "end")).toBe("ended");
  });

  it("el presupuesto se cambia sin mover el estado", () => {
    expect(nextAdsStatus("paused", "budget")).toBe("paused");
    expect(nextAdsStatus("active", "budget")).toBe("active");
    expect(nextAdsStatus("proposal", "budget")).toBeNull();
  });

  it("no se prende nada que no esté creado en pausa", () => {
    expect(nextAdsStatus("proposal", "activate")).toBeNull();
    expect(nextAdsStatus("creating", "activate")).toBeNull();
    expect(nextAdsStatus("error", "activate")).toBeNull();
    expect(nextAdsStatus("ended", "activate")).toBeNull();
    expect(nextAdsStatus("cancelled", "create")).toBeNull();
  });

  it("dos clics a «Crear en pausa»: el segundo ya no aplica", () => {
    expect(nextAdsStatus("creating", "create")).toBeNull();
  });

  it("error: se reintenta o se cancela", () => {
    expect(nextAdsStatus("creating", "create_failed")).toBe("error");
    expect(nextAdsStatus("error", "retry")).toBe("proposal");
    expect(nextAdsStatus("error", "cancel")).toBe("cancelled");
    expect(nextAdsStatus("paused", "cancel")).toBeNull();
  });

  it("inMeta", () => {
    expect(inMeta("paused")).toBe(true);
    expect(inMeta("proposal")).toBe(false);
    expect(inMeta("error")).toBe(false);
  });
});

const NOW = Date.parse("2026-10-01T12:00:00Z");
const base = {
  name: "Ferretería octubre",
  message: "Todo para tu obra con entrega el mismo día. Escríbenos.",
  media_url: "https://cdn.example.com/a.jpg",
  targeting: { interests: [{ id: "6003107902433", name: "Ferretería" }] },
  daily_budget: 50,
  end_time: "2026-10-11T12:00:00Z",
};

describe("parseProposal", () => {
  it("una propuesta completa pasa con edad 25–55 y México por default", () => {
    const p = parseProposal(base, NOW);
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.targeting).toEqual({ ageMin: 25, ageMax: 55, countries: ["MX"], interests: [{ id: "6003107902433", name: "Ferretería" }] });
    expect(p.dailyBudget).toBe(50);
    expect(p.mediaUrl).toBe("https://cdn.example.com/a.jpg");
  });

  it("acepta un adjunto del room como creativo", () => {
    const p = parseProposal({ ...base, media_url: "/api/attachment/abc123" }, NOW);
    expect(typeof p).toBe("object");
    expect(attachmentIdOf("/api/attachment/abc123")).toBe("abc123");
    expect(attachmentIdOf("https://teams.example.com/api/attachment/x9?y=1")).toBe("x9");
    expect(attachmentIdOf("https://cdn.example.com/a.jpg")).toBeNull();
  });

  it("rechaza intereses inventados, sin creativo, presupuesto fuera de rango y fechas malas", () => {
    expect(parseProposal({ ...base, targeting: { interests: [{ id: "cocina", name: "Cocina" }] } }, NOW)).toMatch(/ads_interest_search/);
    expect(parseProposal({ ...base, media_url: "" }, NOW)).toMatch(/creativo/);
    expect(parseProposal({ ...base, media_url: "http://inseguro.com/a.jpg" }, NOW)).toMatch(/https/);
    expect(parseProposal({ ...base, daily_budget: 5 }, NOW)).toMatch(/mínimo/);
    expect(parseProposal({ ...base, daily_budget: "mucho" }, NOW)).toMatch(/pesos/);
    expect(parseProposal({ ...base, end_time: "2026-09-01T00:00:00Z" }, NOW)).toMatch(/futuro/);
    expect(parseProposal({ ...base, end_time: "2027-06-01T00:00:00Z" }, NOW)).toMatch(/90 días/);
    expect(parseProposal({ ...base, message: "corto" }, NOW)).toMatch(/copy/);
  });

  it("edad fuera de rango", () => {
    expect(parseTargeting({ ageMin: 15 })).toMatch(/18 a 65/);
    expect(parseTargeting({ ageMin: 40, ageMax: 30 })).toMatch(/18 a 65/);
    expect(parseTargeting({ age_min: 30, age_max: 45, cities: [{ key: "2673660", name: "Monterrey", radius_km: 20 }] })).toEqual({
      ageMin: 30,
      ageMax: 45,
      cities: [{ key: "2673660", name: "Monterrey", radiusKm: 20 }],
    });
  });
});

describe("números", () => {
  it("techo total = diario × días", () => {
    expect(campaignDays("2026-10-11T12:00:00Z", NOW)).toBe(10);
    expect(maxTotal(50, "2026-10-11T12:00:00Z", NOW)).toBe(500);
    expect(maxTotal(50, "2026-10-01T13:00:00Z", NOW)).toBe(50);
  });

  it("costo por calificado; sin calificados no hay número", () => {
    const f = funnelOf({ spend: 300, conversations: 30, leads: 10, qualified: 4 });
    expect(f.costPerQualified).toBe(75);
    expect(f.costPerLead).toBe(30);
    expect(funnelOf({ spend: 300 }).costPerQualified).toBeNull();
  });

  it("la huella ignora centavos y el orden", () => {
    const a = reportDigest([
      { id: 2, funnel: funnelOf({ spend: 100.2, leads: 1 }) },
      { id: 1, funnel: funnelOf({ spend: 10 }) },
    ]);
    const b = reportDigest([
      { id: 1, funnel: funnelOf({ spend: 10.1 }) },
      { id: 2, funnel: funnelOf({ spend: 100.4, leads: 1 }) },
    ]);
    expect(a).toBe(b);
    expect(reportDigest([{ id: 1, funnel: funnelOf({ spend: 10, qualified: 1 }) }])).not.toBe(reportDigest([{ id: 1, funnel: funnelOf({ spend: 10 }) }]));
  });
});

describe("nextReportAt", () => {
  const tz = "America/Mexico_City"; // UTC−6 todo el año
  it("a las 9 y a las 21 de la CDMX", () => {
    const at8 = Date.parse("2026-10-01T14:00:00Z") / 1000; // 08:00 CDMX
    expect(nextReportAt([9, 21], tz, at8)).toBe(Date.parse("2026-10-01T15:00:00Z") / 1000);
    const at10 = Date.parse("2026-10-01T16:00:00Z") / 1000; // 10:00 CDMX
    expect(nextReportAt([9, 21], tz, at10)).toBe(Date.parse("2026-10-02T03:00:00Z") / 1000);
    const at22 = Date.parse("2026-10-02T04:00:00Z") / 1000; // 22:00 CDMX
    expect(nextReportAt([21, 9], tz, at22)).toBe(Date.parse("2026-10-02T15:00:00Z") / 1000);
  });

  it("horas inválidas caen al default", () => {
    expect(normalizeHours([])).toEqual([9, 21]);
    expect(normalizeHours([25, "x"])).toEqual([9, 21]);
    expect(normalizeHours([21, 9, 9])).toEqual([9, 21]);
  });
});

describe("versiones de la propuesta", () => {
  it("en un hilo con propuesta abierta es versión nueva; si ya se creó o no hay, fila nueva", () => {
    expect(submitMode({ status: "proposal" })).toBe("version");
    expect(submitMode({ status: "paused" })).toBe("new");
    expect(submitMode({ status: "cancelled" })).toBe("new");
    expect(submitMode({ status: "error" })).toBe("new");
    expect(submitMode(null)).toBe("new");
  });

  const current = parseProposal({ ...base, cta: "GET_QUOTE", targeting: { interests: [{ id: "6003107902433", name: "Ferretería" }, { id: "6003384248805", name: "Remodelación" }] } }, NOW);
  if (typeof current === "string") throw new Error(current);

  it("la edición se valida con las mismas reglas", () => {
    expect(applyEdit(current, { message: "corto" }, NOW)).toMatch(/copy/);
    expect(applyEdit(current, { dailyBudget: 5 }, NOW)).toMatch(/mínimo/);
    expect(applyEdit(current, { cta: "CALL_NOW" }, NOW)).toMatch(/cta/);
    expect(applyEdit(current, { endTime: "2026-09-01T00:00:00Z" }, NOW)).toMatch(/futuro/);
    const ok = applyEdit(current, { message: "Material para tu obra, hoy mismo. Mándanos mensaje.", cta: "BOOK_NOW" }, NOW);
    expect(typeof ok).toBe("object");
    if (typeof ok === "string") return;
    expect(ok.cta).toBe("BOOK_NOW");
    expect(ok.mediaUrl).toBe(current.mediaUrl);
    expect(changedFields(current, ok)).toEqual(["message", "cta"]);
    expect(describeChanges(changedFields(current, ok))).toBe("el copy y el botón");
  });

  it("la «×» quita un interés; quitar el último deja la segmentación amplia", () => {
    const one = applyEdit(current, { removeInterestIds: ["6003107902433"] }, NOW);
    if (typeof one === "string") throw new Error(one);
    expect(one.targeting.interests).toEqual([{ id: "6003384248805", name: "Remodelación" }]);
    const none = applyEdit(one, { removeInterestIds: ["6003384248805"] }, NOW);
    if (typeof none === "string") throw new Error(none);
    expect(none.targeting.interests).toBeUndefined();
    expect(changedFields(one, none)).toEqual(["targeting"]);
  });

  it("el máximo total se recalcula al editar presupuesto o fecha", () => {
    const e = applyEdit(current, { dailyBudget: 120, endTime: endTimeFromDate("2026-10-06") }, NOW);
    if (typeof e === "string") throw new Error(e);
    // 1 oct 12:00Z → 6 oct 23:59 CDMX (7 oct 05:59Z): 5.75 días → 6 días × $120
    expect(maxTotal(e.dailyBudget, e.endTime, NOW)).toBe(720);
    expect(maxTotal(current.dailyBudget, current.endTime, NOW)).toBe(500);
  });

  it("sin cta es MESSAGE_PAGE; los 10 botones de gs son válidos", () => {
    const p = parseProposal(base, NOW);
    if (typeof p === "string") throw new Error(p);
    expect(p.cta).toBe("MESSAGE_PAGE");
    expect(CTA_TYPES).toHaveLength(10);
    for (const c of CTA_TYPES) expect(typeof parseProposal({ ...base, cta: c.toLowerCase() }, NOW)).toBe("object");
    expect(changedFields({ ...p, cta: undefined }, p)).toEqual([]);
  });
});

describe("segmentación editable", () => {
  it("edad: enteros de 18 a 65 y mín. ≤ máx.", () => {
    expect(parseTargeting({ ageMin: 18, ageMax: 65 })).toMatchObject({ ageMin: 18, ageMax: 65 });
    expect(parseTargeting({ ageMin: 17 })).toMatch(/18 a 65/);
    expect(parseTargeting({ ageMax: 66 })).toMatch(/18 a 65/);
    expect(parseTargeting({ ageMin: 30, ageMax: 29 })).toMatch(/18 a 65/);
    expect(parseTargeting({ ageMin: 25.5 })).toMatch(/18 a 65/);
  });

  it("zonas: país, estado y ciudad con radio se mezclan; sin zona, México", () => {
    expect(
      parseTargeting({
        countries: ["us"],
        regions: [{ key: "2513", name: "Jalisco" }],
        cities: [{ key: "2673660", name: "Monterrey", radiusKm: 25 }],
      }),
    ).toEqual({
      ageMin: 25,
      ageMax: 55,
      countries: ["US"],
      regions: [{ key: "2513", name: "Jalisco" }],
      cities: [{ key: "2673660", name: "Monterrey", radiusKm: 25 }],
    });
    expect(parseTargeting({ regions: [{ key: "2513" }] })).not.toHaveProperty("countries");
    expect(parseTargeting({})).toMatchObject({ countries: ["MX"] });
  });

  it("rechaza estados sin key, países inválidos y radios fuera de 17–80", () => {
    expect(parseTargeting({ regions: [{ name: "Jalisco" }] })).toMatch(/estado/);
    expect(parseTargeting({ countries: ["México"] })).toMatch(/ISO/);
    expect(parseTargeting({ cities: [{ key: "1", radiusKm: 10 }] })).toMatch(/17 a 80/);
    expect(parseTargeting({ cities: [{ key: "1", radiusKm: 81 }] })).toMatch(/17 a 80/);
  });

  it("la edición manda la segmentación completa y se valida", () => {
    const cur = parseProposal(base, NOW);
    if (typeof cur === "string") throw new Error(cur);
    const next = applyEdit(
      cur,
      { targeting: { ageMin: 30, ageMax: 45, regions: [{ key: "2513", name: "Jalisco" }], interests: [...(cur.targeting.interests ?? []), { id: "6003384248805", name: "Remodelación" }] } },
      NOW,
    );
    if (typeof next === "string") throw new Error(next);
    expect(next.targeting).toEqual({
      ageMin: 30,
      ageMax: 45,
      regions: [{ key: "2513", name: "Jalisco" }],
      interests: [
        { id: "6003107902433", name: "Ferretería" },
        { id: "6003384248805", name: "Remodelación" },
      ],
    });
    expect(changedFields(cur, next)).toEqual(["targeting"]);
    expect(applyEdit(cur, { targeting: { ageMin: 50, ageMax: 40 } }, NOW)).toMatch(/18 a 65/);
  });
});

describe("quitar zonas", () => {
  const withCity = parseProposal({ ...base, targeting: { countries: ["MX"], cities: [{ key: "2673660", name: "Monterrey", radiusKm: 25 }] } }, NOW);
  if (typeof withCity === "string") throw new Error(withCity);

  it("con 2 o más zonas todas llevan «×» (México incluido); la única que queda, no", () => {
    expect(zoneRemovable(withCity.targeting)).toBe(true);
    expect(zoneRemovable({ countries: ["MX"] })).toBe(false);
    expect(zoneRemovable({ cities: [{ key: "1" }] })).toBe(false);
    expect(zoneRemovable({ regions: [{ key: "2513" }], cities: [{ key: "1" }] })).toBe(true);
  });

  it("quitar México deja sólo la otra zona, y es un cambio real que se guarda", () => {
    const next = applyEdit(withCity, { targeting: removeZone(withCity.targeting, { kind: "country", code: "MX" }) }, NOW);
    if (typeof next === "string") throw new Error(next);
    expect(next.targeting.countries).toBeUndefined();
    expect(next.targeting.cities).toEqual([{ key: "2673660", name: "Monterrey", radiusKm: 25 }]);
    expect(changedFields(withCity, next)).toEqual(["targeting"]);
    expect(zoneRemovable(next.targeting)).toBe(false);
  });

  it("quitar la ciudad o el estado agregado también guarda", () => {
    const noCity = applyEdit(withCity, { targeting: removeZone(withCity.targeting, { kind: "city", key: "2673660" }) }, NOW);
    if (typeof noCity === "string") throw new Error(noCity);
    expect(noCity.targeting).toMatchObject({ countries: ["MX"] });
    expect(noCity.targeting.cities).toBeUndefined();
    expect(changedFields(withCity, noCity)).toEqual(["targeting"]);
    const t = { ...withCity.targeting, regions: [{ key: "2513", name: "Jalisco" }] };
    const noRegion = applyEdit(withCity, { targeting: removeZone(t, { kind: "region", key: "2513" }) }, NOW);
    if (typeof noRegion === "string") throw new Error(noRegion);
    expect(noRegion.targeting.regions).toBeUndefined();
  });
});

describe("ads_proposal_submit con cambios parciales", () => {
  const cur = parseProposal({ ...base, cta: "BOOK_NOW", headline: "Entrega hoy", targeting: { countries: ["MX"], interests: [{ id: "6003107902433", name: "Ferretería" }] } }, NOW);
  if (typeof cur === "string") throw new Error(cur);

  it("lo que no se manda se hereda de la vigente (el copy y el botón editados a mano no se pisan)", () => {
    const next = parseProposal(mergeSubmit(cur, { targeting: { regions: [{ key: "2513", name: "Jalisco" }] } }), NOW);
    if (typeof next === "string") throw new Error(next);
    expect(next.message).toBe(cur.message);
    expect(next.cta).toBe("BOOK_NOW");
    expect(next.headline).toBe("Entrega hoy");
    expect(next.dailyBudget).toBe(cur.dailyBudget);
    expect(next.mediaUrl).toBe(cur.mediaUrl);
    // `targeting` se reemplaza ENTERO: los intereses que no se mandaron se van.
    expect(next.targeting).toEqual({ ageMin: 25, ageMax: 55, regions: [{ key: "2513", name: "Jalisco" }] });
    expect(changedFields(cur, next)).toEqual(["targeting"]);
  });

  it("un campo mandado gana, en snake_case o camelCase; null no borra", () => {
    const a = parseProposal(mergeSubmit(cur, { daily_budget: 150, message: null }), NOW);
    const b = parseProposal(mergeSubmit(cur, { dailyBudget: 150 }), NOW);
    if (typeof a === "string" || typeof b === "string") throw new Error("inválida");
    expect(a.dailyBudget).toBe(150);
    expect(a.message).toBe(cur.message);
    expect(b).toEqual(a);
    expect(changedFields(cur, a)).toEqual(["dailyBudget"]);
  });

  it("el resumen del contexto trae copy, botón, presupuesto, zonas y edad", () => {
    const s = summarizeProposal(cur);
    expect(s).toContain(cur.message);
    expect(s).toContain("BOOK_NOW");
    expect(s).toContain("$50 MXN al día");
    expect(s).toContain("zonas MX");
    expect(s).toContain("edad 25–55");
  });
});

describe("cambios pendientes de una campaña en Meta", () => {
  const live = {
    targeting: { ageMin: 25, ageMax: 55, countries: ["MX"], interests: [{ id: "6003107902433", name: "Ferretería" }] },
    endTime: "2026-10-31T23:59:00-06:00",
    message: "Todo para tu obra.",
    headline: null,
    cta: "MESSAGE_PAGE",
  };

  it("diff legible de edad, zonas, intereses y fecha; nada si no cambia", () => {
    const change = parseLiveChange(
      {
        targeting: { ageMin: 25, ageMax: 45, cities: [{ key: "2673660", name: "Monterrey", radiusKm: 25 }], interests: [{ id: "6003384248805", name: "Remodelación" }] },
        endTime: "2026-11-15T23:59:00-06:00",
      },
      NOW,
    );
    if (typeof change === "string") throw new Error(change);
    expect(liveChangeDiff(live, change)).toEqual([
      "Edad 25–55 → 25–45",
      "Zonas MX → Monterrey +25 km",
      "Intereses +Remodelación −Ferretería",
      "Fin 31 oct 2026 → 15 nov 2026",
    ]);
    const same = parseLiveChange({ targeting: live.targeting }, NOW);
    if (typeof same === "string") throw new Error(same);
    expect(liveChangeDiff(live, same)).toEqual([]);
  });

  it("ubicaciones y anuncio nuevo", () => {
    const c = parseLiveChange({ publisherPlatforms: ["facebook", "instagram"], ad: { message: "Material para tu obra, hoy.", cta: "get_quote", mediaUrl: "https://cdn.example.com/b.jpg" } }, NOW);
    if (typeof c === "string") throw new Error(c);
    expect(liveChangeDiff(live, c)).toEqual(["Ubicaciones automáticas → Facebook, Instagram", "Anuncio nuevo: copy, botón «Solicitar cotización», creativo"]);
  });

  it("las plataformas que vienen dentro de la segmentación se separan (van por set_placements)", () => {
    const c = parseLiveChange({ targeting: { ageMin: 30, ageMax: 50, publisherPlatforms: ["facebook"] } }, NOW);
    if (typeof c === "string") throw new Error(c);
    expect(c.targeting).not.toHaveProperty("publisherPlatforms");
    expect(c.publisherPlatforms).toEqual(["facebook"]);
  });

  it("valida: vacío, fecha pasada, plataformas, anuncio sin creativo", () => {
    expect(parseLiveChange({}, NOW)).toMatch(/nada que cambiar/);
    expect(parseLiveChange({ endTime: "2026-09-01T00:00:00Z" }, NOW)).toMatch(/futuro/);
    expect(parseLiveChange({ publisherPlatforms: ["tiktok"] }, NOW)).toMatch(/tiktok/);
    expect(parseLiveChange({ publisherPlatforms: [] }, NOW)).toMatch(/al menos una/);
    expect(parseLiveChange({ ad: { message: "Un copy largo de verdad", mediaUrl: "" } }, NOW)).toMatch(/creativo/);
    expect(parseLiveChange({ targeting: { ageMin: 10 } }, NOW)).toMatch(/18 a 65/);
  });
});

describe("revisión de Meta y token", () => {
  it("parser de review: estado y motivos (del anuncio también), sin repetir", () => {
    expect(parseReview({ state: "rejected", reasons: ["Texto en la imagen"], ads: [{ id: "1", status: "DISAPPROVED", reasons: ["Texto en la imagen", "Promesa de resultado"] }] })).toEqual({
      state: "rejected",
      reasons: ["Texto en la imagen", "Promesa de resultado"],
    });
    expect(parseReview({ state: "raro" })).toBeNull();
    expect(parseReview(null)).toBeNull();
  });

  it("el aviso sale una vez por cambio de estado", () => {
    expect(reviewNotice(4, "in_review", { state: "rejected", reasons: ["Texto en la imagen"] })).toBe("🛑 Meta rechazó el anuncio de #4: Texto en la imagen");
    expect(reviewNotice(4, "rejected", { state: "rejected", reasons: ["x"] })).toBeNull();
    expect(reviewNotice(4, "in_review", { state: "approved", reasons: [] })).toBe("✅ Meta aprobó el anuncio de #4.");
    // La primera vez que se revisa y ya está aprobada: no hace falta avisar.
    expect(reviewNotice(4, null, { state: "approved", reasons: [] })).toBeNull();
    expect(reviewNotice(4, null, { state: "with_issues", reasons: [] })).toMatch(/observaciones/);
  });

  it("token: aviso con 10 días o menos", () => {
    expect(tokenWarning(30, null)).toBeNull();
    expect(tokenWarning(null, null)).toBeNull();
    expect(tokenWarning(10, "2026-10-11T00:00:00Z")).toMatch(/Reconecta Meta antes del 10 oct 2026 \(quedan 10 días\)/);
    expect(tokenWarning(1, "2026-10-02T12:00:00Z")).toMatch(/queda|quedan 1 día/);
    expect(tokenWarning(0, null)).toMatch(/venció/);
  });
});
