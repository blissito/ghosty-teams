import type { ToolDest } from "./tool-token.server";

/**
 * Dónde van a salir los recordatorios de ESTA conversación, dicho con nombre y apellido.
 *
 * Existe por un fallo concreto (2026-08-12): en un DM con Ghosty se pidió *"manda un
 * recordatorio 15 min antes a general"*. El recordatorio se agendó correctamente —en el DM,
 * que es el único sitio donde puede salir— y el agente lo **confirmó como si fuera a salir en
 * `#general`**. La persona se quedó creyendo que el equipo iba a recibir el aviso.
 *
 * No era un bug de permisos ni de datos: el destino sale del `dest` FIRMADO del turno y el
 * modelo no puede tocarlo, que es justo la garantía que queremos. El fallo es que **nadie le
 * había dicho que no podía**, así que aceptó el destino y lo dio por hecho.
 *
 * Va en el contexto ambiental y no en una skill por la regla de siempre
 * (`gotcha_skill_autodescubrible_no_es_leida`): lo que tiene que pasar SIEMPRE no puede
 * depender de que el modelo abra un archivo. La `description` de `reminder_create` lleva la
 * misma regla —y es la que manda, porque viaja en la lista de tools incluso en canales
 * públicos, donde este bloque ni se arma—; esto la refuerza nombrando el sitio concreto, que
 * es lo que convierte "confirma dónde" en algo verificable.
 */
export function remindersContext(dest: ToolDest | null): string | null {
  if (!dest) return null;
  const donde = dest.dmId
    ? "en ESTE DM (sólo lo verá quien está en esta conversación, nadie más)"
    : dest.channelId
      ? `en ESTE room${dest.topic ? `, en el topic "${dest.topic}"` : ""} (lo verá todo el room)`
      : null;
  if (!donde) return null;

  return (
    `[RECORDATORIOS — DÓNDE SALEN. Los que programes en esta conversación se publicarán ${donde}. ` +
    `El destino es FIJO: no puedes mandarlos a otro canal, a otro room, ni por DM a otra persona. ` +
    `Si te piden otro destino ("avisa en #general", "mándaselo a Ana"), NO lo agendes callando ` +
    `la diferencia: dilo en una frase y ofrece la salida — que te lo pidan EN ese canal y ahí ` +
    `queda programado. Al confirmar uno, di DÓNDE va a salir además de cuándo.]`
  );
}
