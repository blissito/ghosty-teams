// Los ajustes que un agente ACP deja cambiar: modelo, modo, esfuerzo…
//
// ⚠️ Hay DOS formas en el mundo real y hay que hablar las dos. Medido el 2026-09-01 contra
// cajas vivas: Gemini CLI devuelve `models`/`modes` en `session/new` (forma vieja) y goose
// devuelve `configOptions` (la de la spec de hoy). Los payloads de abajo son los REALES,
// recortados — no inventados.
import { describe, expect, it } from "vitest";

import { settingsDeSesion } from "./acp-client.server";

/** Lo que contestó la caja de gemini (Gemini CLI). */
const GEMINI = {
  sessionId: "s1",
  models: {
    currentModelId: "auto",
    availableModels: [
      { modelId: "auto", name: "Auto", description: "Let Gemini CLI decide the best model" },
      { modelId: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview" },
      { modelId: "gemini-2.5-pro", name: "gemini-2.5-pro" },
    ],
  },
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default", description: "Prompts for approval" },
      { id: "yolo", name: "YOLO", description: "Auto-approves all tools" },
      { id: "plan", name: "Plan", description: "Read-only mode" },
    ],
  },
};

/** Lo que contestó la caja de goose. */
const GOOSE = {
  sessionId: "s2",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "deepseek-v4-flash",
      options: [
        { value: "deepseek-v4-flash", name: "deepseek-v4-flash" },
        { value: "deepseek-reasoner", name: "deepseek-reasoner" },
      ],
    },
    {
      id: "thinking_effort",
      name: "Thinking effort",
      category: "thought_level",
      currentValue: "off",
      options: [{ value: "off", name: "off" }, { value: "high", name: "high" }],
    },
  ],
};

describe("las dos formas dan la misma estructura", () => {
  it("gemini: `models` y `modes` se traducen", () => {
    const s = settingsDeSesion(GEMINI);
    const modelo = s.find((x) => x.category === "model")!;
    expect(modelo.id).toBe("model");
    expect(modelo.current).toBe("auto");
    expect(modelo.options.map((o) => o.value)).toContain("gemini-2.5-pro");
    // El `via` dice por dónde se escribe, y lo decide el agente al declararlo.
    expect(modelo.via).toBe("model");
    const modo = s.find((x) => x.category === "mode")!;
    expect(modo.via).toBe("mode");
    expect(modo.options.find((o) => o.value === "yolo")?.description).toMatch(/Auto-approves/);
  });

  it("goose: `configOptions` se toma tal cual", () => {
    const s = settingsDeSesion(GOOSE);
    expect(s.map((x) => x.id)).toEqual(["model", "thinking_effort"]);
    expect(s[0].current).toBe("deepseek-v4-flash");
    expect(s[0].via).toBe("config_option");
  });

  it("un agente que no declara nada no aporta ajustes", () => {
    expect(settingsDeSesion({ sessionId: "s3" })).toEqual([]);
  });

  // La spec permite agrupar opciones; aplanarlas es más útil que pintar un encabezado.
  it("las opciones agrupadas se aplanan", () => {
    const s = settingsDeSesion({
      configOptions: [
        {
          id: "provider",
          name: "Provider",
          currentValue: "a",
          options: [{ name: "Nube", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
        },
      ],
    });
    expect(s[0].options.map((o) => o.value)).toEqual(["a", "b"]);
  });

  // Si llegaran las dos, gana la viva: duplicar "Modelo" en la UI sería peor que ignorar una.
  it("con las dos formas, `configOptions` gana", () => {
    const s = settingsDeSesion({ ...GEMINI, configOptions: GOOSE.configOptions });
    expect(s.filter((x) => x.category === "model")).toHaveLength(1);
    expect(s.find((x) => x.category === "model")!.via).toBe("config_option");
  });

  it("una opción sin valores no se pinta: un select vacío no es un ajuste", () => {
    expect(settingsDeSesion({ configOptions: [{ id: "x", name: "X", options: [] }] })).toEqual([]);
  });
});
