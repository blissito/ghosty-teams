# Edición quirúrgica de artefactos HTML (`eb-patch`)

**Estado:** en producción desde 2026-07-25.

Antes, cualquier ajuste a un artefacto HTML hacía que el agente **re-emitiera el documento
completo**: 40 KB de entrada + 40 KB de salida para mover un texto, el artefacto reconstruyéndose
en pantalla, y deriva en cada pasada (el modelo "mejora" lo que nadie pidió). Ahora el agente manda
**solo el nodo que cambia**, direccionado por `data-id`.

Medido en vivo: `aplicados=3 fallidos=0` en **47 ms**, contra ~14 s de regenerar todo.

## El protocolo

Tres operaciones — las mínimas para editar un árbol, nada específico de ningún artefacto:

~~~
```eb-patch a17
<div data-id="a17" class="…">…</div>
```

```eb-remove a17
```

```eb-insert a12 append
<div class="card">nueva</div>
```
~~~

- `eb-patch <id>` — reemplaza ese nodo por el subárbol del bloque.
- `eb-remove <id>` — lo quita. Existe para que borrar un hijo **no** obligue a re-emitir el padre
  (eso repintaba toda la rejilla).
- `eb-insert <ancla> <pos>` — `append`/`prepend` cuelgan dentro del ancla; `before`/`after` lo
  ponen como hermano. Los nodos nuevos **no** traen `data-id`: se lo asigna el server.

Un bloque puede traer **varios elementos hermanos** (pedir dos tarjetas produce dos `<div>`). El id
va en la **cabecera** además de en el fragmento: mientras el fence está abierto todavía no llegó el
atributo, y el panel necesita saber ya a qué nodo apunta. Si difieren, gana la cabecera.

## Las piezas

| Archivo | Rol |
|---|---|
| `src/lib/artifact-ids.ts` | `stampIds` (idempotente) y `nodeIndex` — el mapa que se le da al modelo |
| `src/lib/ebdoc.ts` | `extractEbPatches` / `stripEbPatches` — parser idempotente y tolerante al streaming |
| `src/lib/artifact-patch.ts` | `applyPatches` — la autoridad: aplica por DOM y reporta lo que falla |
| `src/server/artifacts.ts` | `publishArtifactVersion` — camino ÚNICO de publicación |
| `src/components/LiveArtifactPreview.tsx` | aplica los patches en vivo sin repintar el resto |
| `src/components/ArtifactPanel.tsx` | pasa los patches al `EditorStore` del canvas-editor |
| `src/agents.server.ts` | la regla del prompt y `artifactDocHint` (índice + HTML actual) |

## Decisiones que conviene no deshacer

**Los `data-id` los siembra el SERVER al persistir, no el modelo.** El modelo los duplica, los
omite o los renumera, y encarecen cada nodo. `elToNode` del canvas-editor ya respeta los que vengan
en el HTML, así que el editor hereda las direcciones gratis.

**El patch se aplica por DOM sobre el HTML actual, NO con `htmlToDoc → docToHtml`.** Ese camino
regenera el documento entero: emite su propio `<head>`, normaliza el `<style>` y envuelve el body
en un artboard — los `<script>` del artefacto **desaparecen** y una calculadora o un juego dejan de
funcionar. Hay un test que fija esta decisión (`artifact-patch.test.ts`).

**jsdom va `external` en `vite.config.ts`.** Bundleado a ESM revienta con
`__dirname is not defined`; el estampado moría en el catch y el artefacto se guardaba **sin
direcciones**, así que el agente seguía re-emitiéndolo entero. Vive en el `node_modules` de la caja.

**El fallo es visible, nunca mudo.** `[gt-patch] pedidos/aplicados/fallidos` con nodeId y motivo en
el log; chip con los ids en la UI; y si no aplica **ninguno**, no se crea versión (el artefacto
anterior queda intacto) y el bubble lo dice. No hay reintento automático: convertiría "el patch
nunca aplica" en "todo va bien, solo un poco lento".

**Kill-switch:** `ARTIFACT_PATCH=off` en `/app/secrets.env` + restart vuelve al comportamiento
anterior sin deploy.

## Cuándo se re-emite completo (y está bien)

Artefacto nuevo, rediseño o cambio de tema global, cambios en `<head>`/`<style>`/`<script>`, o si el
HTML actual no trae `data-id` (artefacto anterior a esto: se auto-cura al guardarse esa versión).

## Transición sin parpadeo

Al cerrar la edición el panel pasa del preview (DOM) al iframe del resultado. Para que no parpadee:
`ArtifactCalque` pinta el mismo HTML de forma **síncrona** (`dangerouslySetInnerHTML`, mismo commit
de React — `LiveArtifactPreview` pinta en un `useEffect`, un frame tarde) y se desvanece 200 ms
después del `onLoad` del iframe, porque el artefacto carga Tailwind por CDN y sus estilos se aplican
*después* del load. El iframe **no** se gatea con `onLoad`: eso dejaba el panel en negro esperando
subrecursos.
