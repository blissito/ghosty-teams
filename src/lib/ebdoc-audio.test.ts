import { describe, expect, it } from "vitest";
import {
  bubbleWithoutEbAudio,
  bubbleWithoutEbDoc,
  extractAllEbAudio,
  extractAllEbFile,
  extractEbAudio,
  stripEbAudio,
  stripEbFile,
} from "./ebdoc";

// Incidente 2026-07-31 (room Fixtergeek, hilo del contrato de arrendamiento): el agente
// grabó la primera página del contrato en TRES notas de voz. Se publicó la primera y las
// otras quedaron crudas en el chat — el fence sobrevivía en `gc_messages.body`, Markdown lo
// pintaba como bloque de código y el usuario veía la URL FIRMADA del .ogg.
// Causa: `match` sin flag `g` → sólo la primera ocurrencia, más un `return` temprano en el
// servidor. `eb-doc` ya había pasado por esto y lo arregló sólo para sí mismo.
const audio = (n: number) =>
  '```eb-audio\n{"url":"https://t3.storage.dev/ghosty-teams/t3/voz-' +
  n +
  '.ogg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tid%2F20260730%2Fauto%2Fs3","durationMs":20000,"mime":"audio/ogg"}\n```';

const file = (n: number) =>
  '```eb-file\n{"url":"https://t3.storage.dev/x/doc-' + n + '.pdf","name":"contrato' + n + '.pdf","mime":"application/pdf"}\n```';

describe("eb-audio — TODOS los bloques, no sólo el primero", () => {
  it("extrae un solo bloque", () => {
    const all = extractAllEbAudio(`Va la lectura:\n\n${audio(1)}`);
    expect(all).toHaveLength(1);
    expect(all[0].url).toContain("voz-1.ogg");
    expect(all[0].durationMs).toBe(20000);
  });

  it("extrae DOS bloques, en orden", () => {
    const all = extractAllEbAudio(`Encabezado:\n${audio(1)}\nY los incisos:\n${audio(2)}`);
    expect(all.map((a) => a.url.match(/voz-(\d+)/)?.[1])).toEqual(["1", "2"]);
  });

  it("extrae TRES bloques — el caso real que rompió", () => {
    const body = `Va en tres notas.\n${audio(1)}\n${audio(2)}\n${audio(3)}\n¿Sigo con la segunda página?`;
    expect(extractAllEbAudio(body)).toHaveLength(3);
    // Y lo que importa: NADA de eso llega al chat.
    const limpio = stripEbAudio(body);
    expect(limpio).not.toContain("eb-audio");
    expect(limpio).not.toContain("t3.storage.dev");
    expect(limpio).toContain("Va en tres notas.");
    expect(limpio).toContain("¿Sigo con la segunda página?");
  });

  it("extractEbAudio sigue devolviendo el primero (compatibilidad)", () => {
    expect(extractEbAudio(`${audio(7)}\n${audio(8)}`)?.url).toContain("voz-7.ogg");
  });

  it("una URL firmada con & y %2F no rompe el parseo", () => {
    expect(extractEbAudio(audio(1))?.url).toContain("%2F20260730%2Fauto%2Fs3");
  });

  it("ignora un bloque cuyo JSON no trae url", () => {
    expect(extractAllEbAudio('```eb-audio\n{"durationMs":1}\n```')).toHaveLength(0);
  });
});

describe("eb-audio — streaming (bloque aún abierto)", () => {
  it("el bloque abierto no se extrae: el JSON no está completo", () => {
    expect(extractAllEbAudio('```eb-audio\n{"url":"https://t3.storage.dev/x')).toHaveLength(0);
  });

  it("con dos cerrados y uno abierto: los cerrados fuera, el abierto es placeholder", () => {
    const body = `Va:\n${audio(1)}\n${audio(2)}\n\`\`\`eb-audio\n{"url":"https://t3.st`;
    const b = bubbleWithoutEbAudio(body);
    expect(b).toContain("🎙️ Grabando la nota de voz…");
    expect(b).not.toContain("t3.storage.dev");
    expect(b).toContain("Va:");
    // Y ningún fence suelto que le descuadre la paridad a hideDanglingFence.
    expect(b).not.toContain("```");
  });

  it("el fence a medio escribir (```eb-a) sigue dando placeholder", () => {
    expect(bubbleWithoutEbAudio("Grabo esto:\n```eb-a")).toContain("🎙️ Grabando la nota de voz…");
  });
});

describe("eb-file — mismo arreglo que el audio", () => {
  it("extrae varios archivos y los quita todos de la burbuja", () => {
    const body = `Van los dos:\n${file(1)}\n${file(2)}`;
    expect(extractAllEbFile(body)).toHaveLength(2);
    expect(stripEbFile(body)).toBe("Van los dos:");
  });
});

describe("convivencia de bloques en un mismo cuerpo", () => {
  it("audio + eb-doc + gt-tools: cada uno sale por su lado y nada queda crudo", () => {
    const body = [
      '```gt-tools\n{"tools":[{"label":"Grabé una nota de voz","status":"done"}]}\n```',
      "Va la lectura del contrato.",
      audio(1),
      audio(2),
      "```eb-doc\n# Contrato\n\nCláusula primera.\n```",
    ].join("\n\n");
    const b = bubbleWithoutEbDoc(body);
    expect(b).not.toContain("eb-audio");
    expect(b).not.toContain("t3.storage.dev");
    expect(b).not.toContain("gt-tools");
    expect(b).toContain("Va la lectura del contrato.");
  });

  it("audio y archivo en el MISMO turno: los dos se reconocen", () => {
    const body = `Te dejo la nota y el PDF:\n${audio(1)}\n${file(1)}`;
    expect(extractAllEbAudio(body)).toHaveLength(1);
    expect(extractAllEbFile(body)).toHaveLength(1);
    expect(stripEbFile(stripEbAudio(body))).toBe("Te dejo la nota y el PDF:");
  });
});
