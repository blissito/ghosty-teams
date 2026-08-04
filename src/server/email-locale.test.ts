// El idioma de los correos.
//
// Es el único texto del producto que se lee FUERA de la app, y por eso es donde un
// descuido se nota más: quien recibe una invitación a co-editar puede no tener cuenta, así
// que ese correo es su primera —y a veces única— pantalla de Ghosty.
import { describe, expect, it } from "vitest";
import { ghostyEmail } from "./email-template.server";

describe("idioma de los correos", () => {
  it("el pie de un correo externo sale en inglés", () => {
    const { text } = ghostyEmail({
      head: "Ana invited you to edit a document",
      body: "Contrato de arrendamiento",
      cta: { label: "Open the document", url: "https://x.test/d/1" },
      footer: "externo",
      deQuien: "Ana",
      locale: "en",
    });
    expect(text).toContain("Ana is writing to you from Ghosty Teams");
    expect(text).not.toContain("Te escribe");
  });

  it("el pie de un aviso del workspace sale en inglés", () => {
    const { text } = ghostyEmail({
      head: "New mention",
      body: "…",
      cta: { label: "Open the conversation", url: "https://x.test/c/general" },
      footer: "workspace",
      locale: "en",
    });
    expect(text).toContain("Settings → Notifications");
    expect(text).not.toContain("Ajustes");
  });

  it("sin locale sigue saliendo en español: nada cambia para quien ya lo usa", () => {
    const { text } = ghostyEmail({
      head: "Nueva mención",
      body: "…",
      cta: { label: "Abrir la conversación", url: "https://x.test/c/general" },
      footer: "workspace",
    });
    expect(text).toContain("Ajustes → Notificaciones");
  });
});
