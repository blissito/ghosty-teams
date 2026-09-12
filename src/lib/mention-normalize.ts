// `@ghostyinformación` → `@ghosty información`. Misma regla que `detectMentions` en el
// servidor (exacto primero, luego el handle de AGENTE más largo que sea prefijo), aplicada
// al texto ANTES de enviarlo: así el body guardado queda limpio y el resaltado del chat
// (`Markdown.tsx`) y el timbre (`chime.ts`) pintan la mención de verdad y no el token pegado.
export function normalizeMentions(
  body: string,
  mentions: { handle: string; kind: "agent" | "user" | "group" }[],
): string {
  const conocidos = new Set(mentions.map((m) => m.handle.toLowerCase()));
  const agentes = mentions.filter((m) => m.kind === "agent").map((m) => m.handle.toLowerCase());
  return body.replace(/(?<![\p{L}\p{N}_@.])@([\p{L}\p{N}_.-]+)/gu, (todo, tok: string) => {
    const bajo = tok.toLowerCase();
    if (conocidos.has(bajo)) return todo;
    let mejor = "";
    for (const h of agentes) if (bajo.startsWith(h) && h.length > mejor.length) mejor = h;
    return mejor ? `@${mejor} ${tok.slice(mejor.length)}` : todo;
  });
}
