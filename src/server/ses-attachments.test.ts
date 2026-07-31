import { beforeAll, describe, expect, it, vi } from "vitest";

// El MIME de un correo con adjunto no se puede "revisar a ojo": el fallo típico —meter el
// archivo dentro del `multipart/related` en vez de envolver todo en `multipart/mixed`— produce
// un correo que SE ENVÍA sin error y llega sin adjunto visible, porque Gmail y Outlook leen esa
// parte como un recurso del HTML. Esto lee el raw que se le entrega a SES.

const enviados: Buffer[] = [];

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    async send(cmd: { __raw?: Buffer }) {
      if (cmd.__raw) enviados.push(cmd.__raw);
      return { MessageId: "test-id" };
    }
  },
  SendRawEmailCommand: class {
    __raw: Buffer;
    constructor(input: { RawMessage: { Data: Buffer } }) {
      this.__raw = input.RawMessage.Data;
    }
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

let sendSesEmail: typeof import("./ses.server").sendSesEmail;

beforeAll(async () => {
  process.env.SES_KEY = "test-key";
  process.env.SES_SECRET = "test-secret";
  ({ sendSesEmail } = await import("./ses.server"));
});

const raw = () => enviados[enviados.length - 1].toString("utf8");

describe("sendSesEmail — adjuntos", () => {
  it("envuelve en multipart/mixed y marca el archivo como attachment", async () => {
    const ok = await sendSesEmail({
      to: "rh.juridico@example.com",
      subject: "Contrato de arrendamiento",
      html: "<p>Va el contrato.</p>",
      text: "Va el contrato.",
      attachments: [{ fileName: "contrato.docx", bytes: Buffer.from("PKfake"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
    });
    expect(ok).toBe(true);
    const m = raw();
    // Raíz mixed, con el related ANIDADO dentro (no al revés).
    expect(m).toMatch(/^Content-Type: multipart\/mixed/m);
    expect(m).toMatch(/Content-Type: multipart\/related/);
    expect(m.indexOf("multipart/mixed")).toBeLessThan(m.indexOf("multipart/related"));
    // Y el archivo, descargable.
    expect(m).toContain('Content-Disposition: attachment; filename="contrato.docx"');
    expect(m).toContain("Content-Transfer-Encoding: base64");
  });

  it("sin adjuntos ni imágenes NO usa el camino raw", async () => {
    const antes = enviados.length;
    const ok = await sendSesEmail({ to: "a@example.com", subject: "Hola", html: "<p>Hola</p>" });
    expect(ok).toBe(true);
    expect(enviados.length).toBe(antes); // no pasó por SendRawEmailCommand
  });

  it("un nombre de archivo con comillas o CRLF no puede partir la cabecera", async () => {
    await sendSesEmail({
      to: "a@example.com",
      subject: "x",
      html: "<p>x</p>",
      attachments: [{ fileName: 'mal"nombre\r\nBcc: victima@example.com', bytes: Buffer.from("x"), mime: "text/plain" }],
    });
    const m = raw();
    expect(m).not.toContain("Bcc: victima@example.com\r\n");
    expect(m).toMatch(/Content-Disposition: attachment; filename="[^"\r\n]*"/);
  });

  it("acentos en el nombre del archivo van como palabra MIME, no en crudo", async () => {
    await sendSesEmail({
      to: "a@example.com",
      subject: "x",
      html: "<p>x</p>",
      attachments: [{ fileName: "contratación.docx", bytes: Buffer.from("x"), mime: "text/plain" }],
    });
    expect(raw()).toContain("=?UTF-8?B?");
  });

  it("rechaza un mensaje que supera el tope de 10MB de SES", async () => {
    const ok = await sendSesEmail({
      to: "a@example.com",
      subject: "grande",
      html: "<p>x</p>",
      attachments: [{ fileName: "enorme.bin", bytes: Buffer.alloc(9 * 1024 * 1024), mime: "application/octet-stream" }],
    });
    // 9MB en base64 son ~12MB: pasa del tope y hay que decirlo, no intentarlo.
    expect(ok).toBe(false);
  });
});
