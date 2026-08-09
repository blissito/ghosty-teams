import { createFileRoute, redirect } from "@tanstack/react-router";

// `/setup` ya no existe como pantalla. Aquí vivía el wizard de onboarding del owner
// (3 pasos: conectar EasyBits → elegir/crear agente → listo). Se borró el 2026-08-09
// porque sus tres pasos dejaron de tener sentido:
//
//   1. Conectar EasyBits — el runtime es POR AGENTE desde el 2026-07-28
//      (`gc_agents.runtime`); un agente `gs-native` no necesita cuenta de EasyBits.
//   2. Elegir motor / conectar agente — lo hace Ajustes → Agentes, con más superficie
//      (edición, @handle, "De Studio").
//   3. "Listo" — callejón sin salida: no configuraba marca, ni conectores, ni miembros.
//
// Y sobre todo: **todo workspace nace ya con su agente**. Los dos únicos callers de
// `createWorkspace` (`app.tsx` y `/admin/tenants`) pasan `plan: "trial"`, así que
// `seedTrialAgent` siempre corre. Verificado en vivo el 2026-08-09 contra los 9
// workspaces de producción: el único sin agente es `prueba`, el namespace fallido de
// una prueba vieja. El wizard no tenía a quién servir.
//
// Se conserva la ruta como redirect —no se borra el archivo— porque `/setup` está en
// marcadores y en enlaces viejos, y un 404 ahí se lee como "Teams se rompió".
//
// ⚠️ Lo que NO se fue y no hay que confundir: `setup/$provider/*` son los callbacks
// del OAuth per-user de conectores (Calendly, Deník, …) y comparten prefijo con el
// wizard por accidente histórico. `setup/easybits/*` sigue siendo el único camino para
// re-vincular una cuenta de EasyBits, y hay un agente vivo que depende de ella
// (`baloo`, en el workspace `fit-and-geek`, `runtime = easybits`).
export const Route = createFileRoute("/setup/")({
  loader: () => {
    throw redirect({ to: "/c/$slug", params: { slug: "general" } });
  },
});
