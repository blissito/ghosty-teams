# Varios agentes dibujando en UN artefacto (diseño, pendiente)

Anotado el 2026-07-31 tras verlo fallar en vivo. Ya hay una recomendación; falta construir
la única pieza que no existe.

## El problema, tal como se ve

El usuario pide *"manda 12 agentes a dibujar y arma la galería conforme te los van
devolviendo"*. El agente contesta que sí —*"te voy avisando y colgando cada ghosty conforme
aterrice"*— y **no puede cumplirlo**. Peor que fallar: promete algo imposible y deja
esperando.

Y de paso: **al entregar el artefacto el turno se detiene**. El usuario lo lee como que "se
trabó".

## Por qué pasa

**El artefacto ES el texto del agente.** Se escribe como un bloque ` ```eb-artifact ` dentro
de la respuesta y la plataforma lo pinta en el panel conforme streamea. De ahí se siguen las
dos cosas, y son la misma:

- **El turno termina cuando el bloque se cierra.** No hay "seguir después de entregar": el
  bloque era la salida.
- **Los subagentes no pueden escribir en el panel.** Le devuelven texto AL PADRE. El único
  que escribe es el padre, y sólo emitiendo su bloque.

Lo que sí funciona hoy: emitir el bloque **varias veces** en un turno — cada emisión es una
VERSIÓN nueva (cubierto por `src/lib/ebdoc-orphan.test.ts`). Se ve crecer, pero cada versión
re-escribe el HTML completo: caro en tokens y en tiempo.

## Cómo lo resolvió la comunidad (2026)

El consenso: **el agente es un peer más del CRDT, del lado del servidor** — no un cliente que
"manda cambios".

- Base **Yjs + Hocuspocus**: el CRDT converge la estructura, el LLM resuelve los conflictos
  *semánticos*. Son dos capas, no una.
- El agente escribe con **tool calls que se traducen a operaciones CRDT**, no editando el
  Y.Doc a mano ni generando diffs.
- Posiciones por **anclas relativas**, nunca offsets: siguen siendo válidas aunque otro
  escriba a la vez. Es lo que permite N escritores.
- El streaming del agente se **desvía al documento** en vez de al chat.
- Trampa nueva que reportan: un agente escribe a 1,000-4,000 ppm contra 40 de un humano —
  25-100× de desajuste. Duele en prosa compartida; no en regiones separadas.

Referencias: [AI agents as CRDT peers](https://electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs) ·
[CRDTs para multi-agente](https://zylos.ai/research/2026-03-17-crdts-distributed-state-sync-multi-agent-systems/) ·
[Hocuspocus](https://tiptap.dev/docs/hocuspocus/getting-started/overview)

## Recomendación: rejilla con celdas pre-asignadas

El padre abre el artefacto con N huecos numerados y le da a cada subagente **su celda**. Cada
uno escribe sólo esa región del `Y.Doc`.

Por qué ésta y no co-escritura libre:

1. **Elimina el conflicto en vez de resolverlo.** Cada escritor tiene su región y el CRDT ni
   siquiera tiene que decidir: es el caso fácil de Yjs, no el difícil.
2. **Es literalmente el caso de uso.** Una galería es una rejilla. No se está pidiendo
   co-escribir prosa, que es donde el desajuste de velocidad hace daño.
3. **Resuelve las dos quejas de una.** Se ve crecer en vivo Y el turno del padre puede
   terminar sin matar nada, porque los subagentes ya no le devuelven texto: escriben al
   documento.

**Lo que NO haría:** dejar que N agentes escriban prosa libre en el mismo documento. Ahí sí
hacen falta anclas relativas y resolución semántica, y el resultado suele salir incoherente.

## Lo que ya existe (casi todo)

| Pieza | Estado |
|---|---|
| Servidor Yjs | ✅ `templates/collab-svc` (Hocuspocus, persistencia a Tigris) |
| Puente artefacto → `Y.Doc` | ✅ `src/server/collab.ts`: siembra el HTML del documento vivo, abre la sala con permisos y rol |
| Panel que renderiza en vivo | ✅ `ArtifactPanel` |
| **Subagente como peer Yjs** | ❌ **lo único que falta** |

## Lo que falta construir

1. **Cliente Yjs en el subagente** (`templates/claude-worker/sdk/`): conectarse a la sala del
   artefacto con la URL + token que le pase el padre.
2. **Contrato de celda**: el padre le dice a cada subagente *qué región* es suya. Lo más
   simple que funciona: un id de celda y que el subagente sólo escriba ahí.
3. **Que el padre abra la rejilla primero** y termine su turno sin esperar. Hoy tiene que
   quedarse esperando porque los subagentes le devuelven texto.
4. **Token de sala para el subagente**: `collab.ts` ya emite tokens con rol — hay que acuñar
   uno de escritura acotado a la celda, o al menos de escritura al documento.

## Antes de empezar

- Ver `docs/ARTIFACT-PATCH.md` y `docs/ARTIFACTS-STUDIO.md`: puede que parte del contrato de
  edición ya esté resuelto ahí.
- Cuidado con el orden: **primero** el techo de concurrencia de subagentes
  (`templates/claude-worker/sdk/subagent.mjs`, en sandbox-host). Sin eso, 12 agentes
  escribiendo no llegan ni a arrancar — mueren en la cola antes de tocar el documento.
