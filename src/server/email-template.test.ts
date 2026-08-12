import { describe, expect, it } from "vitest";
import { ghostyEmail, splitHead } from "./email-template.server";

// La plantilla es la voz de Ghosty en TODO lo que sale del producto. Lo que se prueba aquí no
// es el diseño (eso sólo se ve abriendo Gmail y Outlook), son las decisiones que se pueden
// afirmar de un HTML: qué promete el pie, si hay botón, y que nada del modelo llegue crudo.

describe("pie según el destinatario", () => {
  it("workspace: ofrece la ruta al opt-out", () => {
    const { html, text } = ghostyEmail({ head: "Te mencionaron", footer: "workspace" });
    expect(html).toContain("Ajustes → Notificaciones");
    expect(text).toContain("Ajustes → Notificaciones");
  });

  it("externo: NO promete unos ajustes que esa persona no tiene", () => {
    // El abogado que recibe un contrato nunca activó nada ni tiene dónde apagarlo. Prometerlo
    // es falso, y en un correo frío la letra chica es justo lo que se lee para decidir si
    // esto es legítimo.
    const { html } = ghostyEmail({ head: "Brendi te compartió un documento", footer: "externo", deQuien: "Brendi" });
    expect(html).not.toContain("Ajustes");
    expect(html).not.toContain("lo activaste");
    // Sin "desde Ghosty Teams": con un cliente que tiene marca propia salía "Te escribe
    // Formmy desde Ghosty Teams", dos nombres de producto en un renglón.
    expect(html).toContain("Te escribe Brendi.");
    expect(html).not.toContain("desde Ghosty Teams");
  });

  it("externo sin nombre no inventa quién escribe", () => {
    const { html } = ghostyEmail({ head: "x", footer: "externo" });
    expect(html).toContain("Enviado desde Ghosty Teams");
  });
});

describe("CTA", () => {
  it("sin cta no pinta botón", () => {
    const { html } = ghostyEmail({ head: "Sólo texto" });
    expect(html).not.toContain("<a href");
  });

  it("una url relativa se completa con la base pública", () => {
    const { html, text } = ghostyEmail({ head: "x", cta: { label: "Abrir", url: "/c/general" } });
    expect(html).toMatch(/href="https?:\/\/[^"]+\/c\/general"/);
    expect(text).toContain("/c/general");
  });

  it("una url absoluta se respeta tal cual", () => {
    const { html } = ghostyEmail({ head: "x", cta: { label: "Abrir", url: "https://otro.example.com/a/1" } });
    expect(html).toContain("https://otro.example.com/a/1");
  });
});

describe("nada del modelo llega crudo", () => {
  it("escapa el cuerpo", () => {
    // El `message` de doc_share y el `body` de email_send los escribe un LLM, y el correo sale
    // con NUESTRO dominio en el From: si pudiera emitir etiquetas sería un inyector de HTML
    // firmado por nosotros.
    const { html } = ghostyEmail({ head: "x", body: '<script>alert(1)</script> y <b>negritas</b>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>negritas</b>");
  });

  it("escapa el título y la etiqueta del botón", () => {
    const { html } = ghostyEmail({ head: '<img onerror=x>', cta: { label: '"><b>', url: "/x" } });
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain('"><b>');
  });
});

describe("splitHead — el título propio de un recordatorio", () => {
  it("parte por el guión largo", () => {
    expect(splitHead("Llamar al notario — confirmar la firma del viernes")).toEqual({
      head: "Llamar al notario",
      rest: "confirmar la firma del viernes",
    });
  });

  it("parte por el primer salto de línea", () => {
    expect(splitHead("Contrato\nrevisar plazo y renta")).toEqual({ head: "Contrato", rest: "revisar plazo y renta" });
  });

  it("sin corte natural, todo es título", () => {
    expect(splitHead("Pagar la renta")).toEqual({ head: "Pagar la renta", rest: "" });
  });
});
