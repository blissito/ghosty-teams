// El `scope` del token: qué puede EJERCER el portador, que es distinto de a qué datos tiene
// derecho (eso lo dice el `sub`) y de dónde puede leerlos (eso, el `dest`).
//
// Existe porque conectar un agente ACP al dispatch le entregaría, si no, todos los conectores
// del invocador a un binario de terceros que ejecuta código escrito por un modelo.
import { describe, expect, it } from "vitest";

import { toolEnScope } from "./tools.server";
import { parseScope } from "./tool-token.server";

describe("el scope de un tool-token", () => {
  it("con `lectura` sólo deja las tres que leen la conversación del turno", () => {
    for (const t of ["chat_history", "chat_search", "doc_read"]) {
      expect(toolEnScope(t, parseScope("lectura"))).toBe(true);
    }
    // Las que escriben o salen del espacio, no. `email_send` es la prueba que importa: es
    // la que convierte "leer un hilo" en "mandar correo a nombre de alguien".
    for (const t of ["email_send", "reminder_create", "form_create", "doc_share", "memory_write"]) {
      expect(toolEnScope(t, parseScope("lectura"))).toBe(false);
    }
  });

  it("una tool DESCONOCIDA queda fuera del scope acotado", () => {
    // La lista es BLANCA a propósito: una tool nueva nace fuera y hay que meterla a mano.
    // Con una lista negra, cada tool que alguien añadiera quedaría al alcance de un agente
    // de terceros sin que nadie lo decidiera.
    expect(toolEnScope("gmail_send_super_nueva", parseScope("lectura"))).toBe(false);
    expect(toolEnScope("gmail_send_super_nueva", parseScope("completo"))).toBe(true);
  });

  it("con `completo` no estorba a nadie: es lo que reciben los agentes nativos", () => {
    expect(toolEnScope("email_send", parseScope("completo"))).toBe(true);
  });
});

/**
 * Familias por prefijo. El diseño se apoya en una sola regla, y es la que hay que blindar:
 * un prefijo que nadie declaró NO pertenece a ninguna familia acotada, así que sólo lo
 * alcanza `completo`. Una tool nueva nace fuera; el olvido falla cerrado.
 */
describe("familias de alcance", () => {
  const codigo = parseScope("lectura,codigo");

  it("`codigo` da GitHub — y sólo GitHub", () => {
    for (const t of ["github_create_issue", "github_checkout", "github_create_pr", "github_merge_pr"]) {
      expect(toolEnScope(t, codigo)).toBe(true);
    }
    // Lo que hizo falta la mañana del 19 ago y no estaba: el issue del room.
    expect(toolEnScope("github_create_issue", parseScope("lectura"))).toBe(false);
  });

  it("`codigo` NO arrastra el correo ni los conectores de nadie", () => {
    for (const t of ["email_send", "sentry_issues", "calendly_book", "gmail_send"]) {
      expect(toolEnScope(t, codigo)).toBe(false);
    }
  });

  it("🔴 un prefijo que nadie declaró queda fuera de toda familia acotada", () => {
    expect(toolEnScope("stripe_refund", codigo)).toBe(false);
    expect(toolEnScope("stripe_refund", parseScope("lectura,codigo,tareas,agenda"))).toBe(false);
    expect(toolEnScope("stripe_refund", parseScope("completo"))).toBe(true);
  });

  it("`doc_read` es lectura y `doc_share` no, aunque empiecen igual", () => {
    // Por eso las de lectura van por lista blanca y no por prefijo: `doc_read` lee y
    // `doc_share` reparte. Aquí la precisión importa más que la regla general.
    expect(toolEnScope("doc_read", parseScope("lectura"))).toBe(true);
    expect(toolEnScope("doc_share", parseScope("lectura"))).toBe(false);
    expect(toolEnScope("doc_share", parseScope("docs"))).toBe(true);
  });

  it("un alcance vacío o ausente vale `completo`: los nativos no cambian", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(toolEnScope("email_send", parseScope(raw))).toBe(true);
    }
  });

  it("se lee tolerante: mayúsculas y espacios no cambian el permiso", () => {
    expect(toolEnScope("github_create_issue", parseScope(" Lectura , CODIGO "))).toBe(true);
  });
});
