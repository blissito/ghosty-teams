import { describe, it, expect } from "vitest";
import { normalizeAlert, formatGenericAlert } from "./alert-normalize";

// Cuerpos reales (recortados) de cada proveedor. Lo que importa: estado bien leído, y que la
// MISMA alerta dé la misma huella al dispararse y al recuperarse.

describe("normalizeAlert", () => {
  it("Datadog: triggered y recovered comparten huella", () => {
    const base = { id: "1", title: "[Triggered] CPU alta en api-1", body: "avg:system.cpu > 90", alert_id: "4242", org: { name: "acme" } };
    const t = normalizeAlert({ ...base, alert_transition: "Triggered" });
    const r = normalizeAlert({ ...base, id: "2", title: "[Recovered] CPU alta en api-1", alert_transition: "Recovered" });
    expect(t.source).toBe("Datadog");
    expect(t.status).toBe("firing");
    expect(r.status).toBe("resolved");
    expect(t.key).toBe(r.key);
    expect(t.eventId).not.toBe(r.eventId);
  });

  it("Grafana: firing / resolved", () => {
    const g = (status: string) =>
      normalizeAlert({
        receiver: "ghosty",
        status,
        orgId: 1,
        title: `[${status.toUpperCase()}:1] Latencia p95`,
        message: "p95 > 2s",
        groupKey: "{}:{}",
        alerts: [{ status, labels: { alertname: "Latencia p95", instance: "web-1" }, annotations: {}, generatorURL: "https://grafana.acme.mx/alerting/1" }],
      });
    expect(g("firing").status).toBe("firing");
    expect(g("resolved").status).toBe("resolved");
    expect(g("firing").key).toBe(g("resolved").key);
    expect(g("firing").source).toBe("Grafana");
    expect(g("firing").link).toContain("grafana.acme.mx");
  });

  it("Better Stack: incidente abierto y resuelto", () => {
    const open = normalizeAlert({ data: { id: "77", type: "incident", attributes: { name: "acme.mx caído", url: "https://acme.mx", cause: "Status 502" } } });
    const done = normalizeAlert({ data: { id: "77", type: "incident", attributes: { name: "acme.mx caído", url: "https://acme.mx", resolved_at: "2026-09-24T10:00:00Z" } } });
    expect(open.status).toBe("firing");
    expect(done.status).toBe("resolved");
    expect(open.key).toBe(done.key);
    expect(open.eventId).not.toBe(done.eventId);
  });

  it("UptimeRobot (form-urlencoded ya parseado)", () => {
    const down = normalizeAlert({ monitorFriendlyName: "Tienda", monitorURL: "https://tienda.mx", alertType: "1", alertTypeFriendlyName: "Down", alertDetails: "Connection Timeout" });
    const up = normalizeAlert({ monitorFriendlyName: "Tienda", monitorURL: "https://tienda.mx", alertType: "2", alertTypeFriendlyName: "Up" });
    expect(down.status).toBe("firing");
    expect(up.status).toBe("resolved");
    expect(down.key).toBe(up.key);
  });

  it("genérico: títulos con números distintos son el mismo problema", () => {
    const a = normalizeAlert({ title: "Cola con 1200 jobs atorados", status: "error" });
    const b = normalizeAlert({ title: "Cola con 1350 jobs atorados", status: "error" });
    expect(a.status).toBe("firing");
    expect(a.key).toBe(b.key);
    expect(a.source).toBe("Webhook");
  });

  it("no acepta links que no sean http(s)", () => {
    const a = normalizeAlert({ title: "x", url: "javascript:alert(1)" });
    expect(a.link).toBe("");
  });

  it("la tarjeta nombra el webhook y el estado", () => {
    const a = normalizeAlert({ title: "Disco lleno", message: "95%", status: "firing" });
    const card = formatGenericAlert(a, "prod");
    expect(card).toContain("🚨");
    expect(card).toContain("Disco lleno");
    expect(card).toContain("«prod»");
  });
});
