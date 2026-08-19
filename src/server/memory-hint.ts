/**
 * Formato del bloque de memoria de ROOM que viaja en cada turno.
 *
 * Vive aparte y sin un solo import porque es la parte con reglas —presupuesto compartido,
 * quién come primero, qué sale en la cola— y es lo único de `memoryHint` que se puede probar
 * sin levantar la DB ni el resto de `agents.server`.
 */

export type RoomMemoryNote = {
  id: number;
  note: string;
  /** `''` = lineamiento del espacio; `@x` = nota dictada a ese agente. */
  agentHandle: string;
};

export type RoomMemoryBlock = {
  /** Lineamientos que caben, de más viejo a más nuevo (el orden en que se acordaron). */
  rules: string[];
  /** Notas del propio agente que caben, mismo orden. */
  own: string[];
  /** Ids que no cupieron, para que el agente pueda pedirlas con memory_read. */
  overflow: number[];
  /** Cuántas quedaron fuera en total (`overflow` va acotado). */
  rest: number;
};

/** Tope de ids que se enumeran en la cola: una lista larga es tan opaca como un número. */
const MAX_OVERFLOW_IDS = 12;

/**
 * Reparte el presupuesto entre los dos orígenes.
 *
 * Los LINEAMIENTOS comen primero a propósito: son la regla del espacio y rigen para cualquier
 * agente, así que elidir uno se lee como incumplimiento, no como olvido. Dentro de cada grupo
 * se consume de más NUEVO a más viejo —para que el tope tire lo rancio— y se imprime al revés.
 */
export function splitRoomMemory(notes: RoomMemoryNote[], maxChars: number): RoomMemoryBlock {
  let used = 0;
  let rest = 0;
  const overflow: number[] = [];

  const take = (subset: RoomMemoryNote[]): string[] => {
    const lines: string[] = [];
    for (const n of [...subset].reverse()) {
      const line = `#${n.id}: ${n.note}`;
      if (used + line.length > maxChars) {
        rest++;
        if (overflow.length < MAX_OVERFLOW_IDS) overflow.push(n.id);
        continue;
      }
      used += line.length;
      lines.push(line);
    }
    return lines.reverse();
  };

  const rules = take(notes.filter((n) => n.agentHandle === ""));
  const own = take(notes.filter((n) => n.agentHandle !== ""));
  return { rules, own, overflow, rest };
}

/** El bloque ya redactado. Cadena vacía si no hay nada que decir. */
export function renderRoomMemory(block: RoomMemoryBlock): string {
  return (
    (block.rules.length
      ? `Lineamientos de este espacio (rigen aquí para cualquier agente — respétalos sin volver a preguntar):\n` +
        block.rules.join("\n") +
        `\n`
      : "") +
    (block.own.length
      ? `De esta conversación (convenciones YA ACORDADAS aquí — respétalas sin volver a preguntar):\n` +
        block.own.join("\n") +
        `\n`
      : "") +
    // La cola sale DIRECCIONABLE, no como un número: un id se puede leer, un conteo no.
    (block.rest > 0
      ? `…y ${block.rest} más que no caben: #${block.overflow.join(", #")} (léelas con memory_read si vienen al caso)\n`
      : "")
  );
}
