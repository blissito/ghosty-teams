import { describe, it, expect } from "vitest";
import { extractAlert, stripAlert, bubbleWithoutEbDoc } from "./ebdoc";
import { formatAlert } from "./sentry-alert";

// El payload REAL de la alerta que llegó al canal de smatch-mobile el 2026-08-04. Es el
// caso que motivó la tarjeta: el `culprit` traía el path absoluto de la laptop de quien
// compiló y se comía la línea entera.
const PAYLOAD = {
  id: "6789",
  project: "smatch-mobile",
  project_name: "smatch-mobile",
  level: "error",
  culprit: "Button.props.onPress(/Users/davidzavala/projects/smatch/apps/client-mobile/src/components/HomeScreen.tsx)",
  url: "https://smatch-6g.sentry.io/issues/6789/",
  triggering_rules: ["Ghosty Teams"],
  event: {
    event_id: "abc123",
    title: "Error: Sentry test error from HomeScreen button",
    environment: "development",
    tags: [["environment", "development"], ["level", "error"]],
  },
};

const ISSUE = {
  shortId: "SMATCH-MOBILE-C",
  count: 15,
  userCount: 1,
  substatus: "escalating",
  permalink: "https://smatch-6g.sentry.io/issues/6789/",
};

describe("formatAlert", () => {
  it("parte el culprit en archivo y función, y NO imprime el path absoluto", () => {
    const body = formatAlert(PAYLOAD, ISSUE, "ghosty");
    const card = extractAlert(body)!;
    expect(card.file).toBe("HomeScreen.tsx");
    expect(card.fn).toBe("Button.props.onPress");
    // Lo que rompía la tarjeta vieja: la ruta de la máquina de alguien más.
    expect(body).not.toContain("/Users/");
  });

  it("trae los conteos del issue, que el webhook no manda", () => {
    const card = extractAlert(formatAlert(PAYLOAD, ISSUE, "ghosty"))!;
    expect(card.count).toBe(15);
    expect(card.users).toBe(1);
    expect(card.shortId).toBe("SMATCH-MOBILE-C");
    expect(card.env).toBe("development");
    expect(card.substatus).toBe("escalating");
  });

  it("sin issue sale igual, sólo sin conteos — nunca se pierde la alerta", () => {
    const card = extractAlert(formatAlert(PAYLOAD, null, "ghosty"))!;
    expect(card.title).toContain("Sentry test error");
    expect(card.count).toBeNull();
    expect(card.users).toBeNull();
    // Sin shortId no se ofrece silenciar: el agente tendría que ADIVINAR qué issue,
    // y sentry_update_issue modifica de verdad.
    expect(card.actions.map((a) => a.label)).toEqual(["Proponer el fix"]);
  });

  it("las acciones llevan la @mención del agente, o el clic no despierta a nadie", () => {
    const card = extractAlert(formatAlert(PAYLOAD, ISSUE, "blue"))!;
    expect(card.actions).toHaveLength(2);
    for (const a of card.actions) expect(a.send.startsWith("@blue ")).toBe(true);
    expect(card.actions[1].send).toContain("SMATCH-MOBILE-C");
  });

  it("deja una línea de texto plano bajo el fence (citas, buscador, notificación)", () => {
    const body = formatAlert(PAYLOAD, ISSUE, "ghosty");
    const plain = stripAlert(body);
    expect(plain).toBe("SMATCH-MOBILE-C · error · Error: Sentry test error from HomeScreen button");
    expect(plain).not.toContain("{");
  });

  it("aguanta un payload pelado sin reventar", () => {
    const card = extractAlert(formatAlert({}, null, "ghosty"))!;
    expect(card.title).toBe("Error en Sentry");
    expect(card.level).toBe("error");
    expect(card.file).toBe("");
  });

  it("parte también el culprit estilo Python (`archivo in funcion`)", () => {
    const card = extractAlert(
      formatAlert({ ...PAYLOAD, culprit: "/srv/app/api/views.py in create_order" }, null, "ghosty"),
    )!;
    expect(card.file).toBe("views.py");
    expect(card.fn).toBe("create_order");
  });
});

describe("extractAlert", () => {
  it("no pinta la tarjeta con el fence sin cerrar", () => {
    expect(extractAlert('```gt-alert\n{"title":"x"}')).toBeNull();
  });

  it("descarta botones sin `send` — un botón que no hace nada es peor que ninguno", () => {
    const card = extractAlert(
      '```gt-alert\n{"title":"x","actions":[{"label":"Va"},{"label":"Ok","send":"hola"}]}\n```',
    )!;
    expect(card.actions).toEqual([{ label: "Ok", send: "hola" }]);
  });

  it("sin título no hay tarjeta", () => {
    expect(extractAlert('```gt-alert\n{"level":"error"}\n```')).toBeNull();
  });
});

describe("bubbleWithoutEbDoc", () => {
  it("al pintar quita el fence: el JSON crudo nunca se ve en el chat", () => {
    const body = formatAlert(PAYLOAD, ISSUE, "ghosty");
    expect(bubbleWithoutEbDoc(body)).not.toContain("gt-alert");
    expect(bubbleWithoutEbDoc(body)).not.toContain('"actions"');
  });

  it("al GUARDAR lo conserva: el cliente saca la tarjeta del propio body", () => {
    const body = formatAlert(PAYLOAD, ISSUE, "ghosty");
    expect(bubbleWithoutEbDoc(body, undefined, { keepStatus: true })).toContain("gt-alert");
  });
});
