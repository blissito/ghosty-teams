// El `scope` del token: qué puede EJERCER el portador, que es distinto de a qué datos tiene
// derecho (eso lo dice el `sub`) y de dónde puede leerlos (eso, el `dest`).
//
// Existe porque conectar un agente ACP al dispatch le entregaría, si no, todos los conectores
// del invocador a un binario de terceros que ejecuta código escrito por un modelo.
import { describe, expect, it } from "vitest";

import { toolEnScope } from "./tools.server";

describe("el scope de un tool-token", () => {
  it("con `lectura` sólo deja las tres que leen la conversación del turno", () => {
    for (const t of ["chat_history", "chat_search", "doc_read"]) {
      expect(toolEnScope(t, "lectura")).toBe(true);
    }
    // Las que escriben o salen del espacio, no. `email_send` es la prueba que importa: es
    // la que convierte "leer un hilo" en "mandar correo a nombre de alguien".
    for (const t of ["email_send", "reminder_create", "form_create", "doc_share", "memory_write"]) {
      expect(toolEnScope(t, "lectura")).toBe(false);
    }
  });

  it("una tool DESCONOCIDA queda fuera del scope acotado", () => {
    // La lista es BLANCA a propósito: una tool nueva nace fuera y hay que meterla a mano.
    // Con una lista negra, cada tool que alguien añadiera quedaría al alcance de un agente
    // de terceros sin que nadie lo decidiera.
    expect(toolEnScope("gmail_send_super_nueva", "lectura")).toBe(false);
    expect(toolEnScope("gmail_send_super_nueva", "completo")).toBe(true);
  });

  it("con `completo` no estorba a nadie: es lo que reciben los agentes nativos", () => {
    expect(toolEnScope("email_send", "completo")).toBe(true);
  });
});
