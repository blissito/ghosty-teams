# Teams → AG-UI (fase 1: inventario y mapeo)

> Encargo: migrar el consumo de turnos de gs (contrato viejo «B»: `message-stream` + `turns`) al
> contrato **gs-agui 1** (`~/ghosty-studio/docs/claude/agui-adopcion.md` §0 y §0.7c; base
> `~/ghostykit/docs/protocol.md`). Sin traductor ni compatibilidad hacia atrás.
> Estado 2026-10-18: **fase 2 escrita del lado de Teams, sin desplegar**. Endpoint decidido por
> team-lead: `POST /api/v2/fleet-agents/:id/agui` (firma de workspace, motor `prepareTeamsTurn`/
> `routeTurn`), lo implementa gs-agui en la rama `agui`. No se despliega hasta su aviso.

## 1. Qué consume hoy Teams de gs

Sólo el runtime **`gs-native`** habla «B». Los demás no se tocan:

| Runtime (`gc_agents.runtime`) | Transporte | ¿Entra en esta migración? |
|---|---|---|
| `gs-native` | HTTP + HMAC de workspace (`x-ghosty-ts/ws/sig`, `GHOSTY_PARTNER_SECRET`) | **Sí** |
| `easybits` | `POST {EasyBits}/api/v2/fleet-agents/:id/message-stream` (Bearer) | No: es el endpoint de EasyBits, no de gs. Comparte parser con el nativo → hay que separar las ramas |
| `acp` | WebSocket directo a la caja (`acp-client.server.ts`, `runAcpTurn`) | No |
| `a2a` | `a2a-client.server.ts` | No |

### Llamadas de turno (lo que cambia)

| Dónde | Qué hace |
|---|---|
| `src/agents.server.ts:1684` `callAgentBackendStream` (rama `native`, ~2470-2730) | Turno durable: `POST /api/v2/fleet-agents/:id/turns {…, turnId:"teams:<uuid>"}` → 202 → `GET …/turns/:turnId/events` con `Last-Event-ID` (dedupe por `id:` seq). Si gs da 404/405 cae a `POST …/message-stream`. Detener = `POST …/turns/:turnId/cancel` (además de abortar el fetch). |
| `src/agents.server.ts:3051` `runAgentTurn` | Único llamador de chat (rooms `server/chat.ts`, DMs `server/dm.ts`). Guarda el turnId durable (`rememberDurable` → `turns.server.ts:405 setTurnDurable` → `gt_turns.durable_turn_id`). |
| `src/server/prospeccion/write.server.ts:370`, `src/routes/api.prospeccion.agent.ts:78` | Usan `callAgentBackendStream` sin durable (celdas y drawer de Prospección). Sólo dependen de `onChunk`/`onTool`. |
| `src/server/apps/factory-runs.server.ts:1001` `steerRole` | Steer suelto de la fábrica: `message-stream {inject:true, injectOnly:true}` y lee hasta `injected` (true) o `not_live`/`error`/`done` (false). Timeout 10 s. |

### Llamadas que NO son el chat (REST, se quedan como están)

`GET/POST /api/v2/fleet-agents` (`fleet-native.server.ts`), `POST …/:id/acp-box`, `POST …/:id/session/reset`
(`/clear`, `agents.server.ts:2777`). Y las que gs hace **hacia** Teams: `toolsUrl` (tools de
conectores con `toolToken`), `wakeUrl`/`wakeRef` (despertador). Nada de esto es AG-UI.

### Body que manda Teams (mismo en `turns` y `message-stream`, `TeamsTurnBody` de gs)

`groupId`, `configGroupId:"teams"`, `sender`, `text` (con todos los hints pegados), `parts` (FileParts
A2A), `appendSystemPrompt` (contexto de canal), `toolToken`+`toolsUrl`, `wakeUrl`+`wakeRef`, `inject`,
`injectOnly`, `messageRef`, `boardId`, `model`, `nativeSubagents`, `childProfile`, `turnId`.

### Eventos «B» que lee Teams y qué hace con ellos

| Frame | Uso en Teams |
|---|---|
| `chunk {value}` | `onChunk` → burbuja en vivo |
| `tool {name,id,phase:start\|end,ok,detail,todos,sub}` | `onTool` → checklist ✅/❌ por id, plan (`gt-todos`), filas de subagente (`gs_subagent_child` + `sub`). Tool «sucia» apaga el reintento ciego |
| `progress {id,elapsedMs}` | reloj de la tool abierta (cada 20 s) |
| `stalled {rule,tool,detail,count,secs,since,human,steer}` | `factory-runs.onRoleStalled` (aviso / steer en la fábrica) |
| `truncated {subtype,classification,numTurns,stopReason,notice}` | `avisoDeCorte` (sin pisar el texto); `gs_restart`/`worker_lost` = «Continuar» |
| `injected` | devuelve `INJECTED`: la respuesta sale por la burbuja del turno vivo |
| `reply_to {messageIds,folded}` | dónde empieza la respuesta a cada mensaje inyectado |
| `attachments {failed:[{name,reason}]}` | pie «no llegaron estos adjuntos» |
| `not_live` | sólo `steerRole` (`injectOnly` sin turno vivo) |
| `done {value,model,stopped?}` | `value` = texto **autoritativo** que se persiste (pisa lo acumulado); `model` al pie |
| `error {message}` | lanza → aviso «No pude contactar» + `onFailure` (no se cobra) |
| HTTP `402 {message}` | aviso de saldo como respuesta, sin lanzar |
| HTTP `503` + `Retry-After` | drenado de gs → reintento |

### Durabilidad y reintentos (lado Teams)

- `gt_turns` (persistido) + mapa en memoria (`turns.server.ts`); latido `heartbeat_at`.
- `sweepOrphans` al tocar un tenant: turnos sin latido con `durable_turn_id` se **adoptan** (wakeup
  `adopt:{shellId,turnId}` → `runAgentTurn({durableResume})` → `GET …/events` desde el inicio, misma
  burbuja). Sin turnId → «⏹ Interrumpido» + `autoRetomarConPlan`.
- Reintento de transporte: `ESPERAS_MS [5,15,30,60] s` (o `Retry-After`), sólo si es durable o aún no
  hubo texto ni tool sucia. `IDLE_MS 90 s` sin bytes = `terminated` (gs manda `: hb` cada 15 s).
- 401 → refresco de token sólo en EasyBits (`refreshesOn401`); el HMAC no caduca.
- Realtime Teams→navegador (`bus.server.ts`, SSE propio) y Yjs (`collab*.ts`, documentos): **internos,
  no cambian**. El navegador nunca ve frames de gs.

## 2. Mapeo «B» → AG-UI

| «B» | AG-UI (gs-agui 1) | Nota |
|---|---|---|
| `POST /turns` + `GET /events` + `Last-Event-ID` | Un `POST …/agui` (`runId` = turnId durable, idempotente). Reenganche = mismo `runId` / `messages:[]` | Teams deja de deduplicar por seq: al reconectar llega lo abierto **re-emitido acumulado** (§0.7b.4) → la burbuja se **reemplaza**, no se concatena |
| `POST /turns/:id/cancel` | `forwardedProps.cancel = runId` | — |
| `message-stream` (fallback 404) | desaparece | sin compat |
| `chunk` | `TEXT_MESSAGE_START/CONTENT/END` | varios `messageId` por run (texto antes y después de tools): Teams los concatena en una burbuja |
| `tool start/end`, `ok` | `TOOL_CALL_START/ARGS/END` + `TOOL_CALL_RESULT` (`metadata.error` = ❌) | — |
| `tool.detail` | `CUSTOM ghosty.tool {toolCallId,title,kind,path,detail}` | — |
| `tool.todos` | `TOOL_CALL_ARGS` de `TodoWrite` (JSON) | Teams parsea los args |
| `tool.sub` / `gs_subagent_child` | `STATE_SNAPSHOT`/`STATE_DELTA` `subagents.tasks[]` | Teams deriva start/step/end comparando snapshots |
| `progress` | — (se elimina) | Teams calcula `elapsedMs` desde su `TOOL_CALL_START` |
| `stalled` | **`CUSTOM ghosty.stalled`** (mismo payload) | falta en el contrato |
| `truncated` | **`RUN_FINISHED.metadata.truncated {subtype,classification,numTurns,stopReason,notice}`** | falta; distinto de `metadata.interrupted` (§0.7d) |
| `injected` | `CUSTOM ghosty.injected {messageId}` | ✓ contrato |
| `reply_to` | **`CUSTOM ghosty.reply_to {messageIds,folded}`** | falta; `messageIds` = ids de `messages[].id` que mandó Teams |
| `attachments` | `CUSTOM ghosty.attachments_failed` | contrato trae `{names,message}`; Teams necesita **el porqué por archivo** `{failed:[{name,reason}]}` |
| `not_live` | **`409 {error:"run_not_live"}`** con `injectOnly` | falta |
| `done.value` | `RUN_FINISHED.result` (string, ya redactado) | AG-UI ya tiene `result` |
| `done.model` | `RUN_FINISHED.usage[].model` | ✓ |
| `done.stopped` | `outcome:"cancelled"` | ✓ |
| `error` | `RUN_ERROR {message, code?}` | ✓ |
| 402 / 503+Retry-After | iguales (`quota_exceeded`, drenado) | ✓ |
| permisos | `forwardedProps.permissions:"auto"` (Teams nativo no pide permisos) | sin interrupts por ahora |
| `MESSAGES_SNAPSHOT` | se ignora (Teams guarda su propio hilo) | conviene poder omitirlo (`noCopy`) |

Request: `threadId` = `groupId`, `runId` = turnId, `messages:[{id:"teams:<msgId>", role:"user",
content:[text + image/document]}]` (los FileParts A2A pasan a content parts). El resto a
`forwardedProps`: `agent` (fleetAgentId), `configGroupId`, `sender`, `appendSystemPrompt`, `token`
(turnToken), `toolToken`, `toolsUrl`, `wakeUrl`, `wakeRef`, `boardId`, `model`, `nativeSubagents`,
`childProfile`, `steer`, `injectOnly`, `cancel`, `permissions:"auto"`.

## 3. Qué falta en gs (rama `agui`)

1. **🚨 `/api/v2/partner/agui` hoy NO sirve para Teams.** Es el partner tipo Deník: auth sólo
   `x-ghosty-key` (tabla `Partner`) u OAuth (`requirePartnerCaller`), agente por **slug** de partner
   (`getPartnerAgentRow`) y motor `runPartnerTurn`. Teams firma como **workspace** (`x-ghosty-ws` +
   secreto de plataforma), elige el agente por **fleetAgentId** (varios por espacio, y la fábrica cambia
   de fleetId por turno) y corre por `prepareTeamsTurn` → `routeTurn` (conectores, despertador, tablero,
   modelo, hijos nativos, relé/adopción entre cajas, vigilante de atascos). Hace falta una de dos:
   - (a) rama «workspace» en `partner/agui`: si viene `x-ghosty-ws`, `verifyPartnerRequestAsync` +
     `requireAgentOwner(forwardedProps.agent)` y fuente = eventos AG-UI crudos de `prepareTeamsTurn`/
     `routeTurn` (sin `pumpTeamsFrames`); `tenant` = el ns firmado.
   - (b) `POST /api/v2/fleet-agents/:id/agui` con la auth de hoy. **Recomiendo (b)**: no mezcla dos
     motores en una ruta y el agente ya va en la URL como en `turns`.
2. Eventos que faltan en el contrato: `ghosty.stalled`, `ghosty.reply_to`, `metadata.truncated`,
   `attachments_failed` con `reason` por archivo, `409 run_not_live` para `injectOnly`.
3. Steer sin conocer el runId vivo: `steerRole` (fábrica) no lo tiene. Aceptar `forwardedProps.steer:true`
   (= «el run vivo de este hilo, sea cual sea») o exponer el run vivo del hilo.
4. Durabilidad equivalente a `turns`: el run sobrevive al cliente (ya), reenganche por `runId` tras
   reinicio de gs (`adoptTeamsTurn`/relé hoy cubren caja muerta y otra instancia) y `RUN_FINISHED` con
   `metadata.interrupted` cuando gs perdió el turno (hoy `truncated worker_lost`).
5. `messageRef` sale sobrando si `ghosty.injected.messageId`/`reply_to` usan los `messages[].id`.

## 4. Fase 2 en Teams (hecha, sin desplegar)

- `src/server/gs-agui.server.ts`: `buildRunInput` (RunAgentInput + content parts), `AguiTurnReader`
  (un lector por turno; deduplica lo re-emitido al reconectar, deriva subagentes de `state`, reloj
  local de tools cada 20 s) y JSON Patch mínimo para `STATE_DELTA`.
- `src/agents.server.ts` `nativeAguiTurn`: rama `gs-native` de `callAgentBackendStream`. El body viejo
  pasa entero a `forwardedProps`; reconectar = mismo `runId` con `messages: []`; adopción igual;
  Detener = `forwardedProps.cancel`; `409 run_active` = esperar (5 s o `Retry-After`, hasta 60 min) y
  mandarlo como turno normal; 402 = aviso de saldo; 429/502/503/504 y cortes = reintento.
  La rama EasyBits conserva `message-stream`.
- `factory-runs.server.ts` `steerRole`: `steer: true` + `injectOnly`, lee hasta `ghosty.injected`.
- Pruebas: `src/server/gs-agui.test.ts` (20, streams grabados + extremo a extremo con gs simulado).
- Rótulo unificado del turno cortado: **«Continuar»** (botón, aviso, placeholder `⏳ Continuando…`;
  `⏳ Retomando…` se sigue reconociendo en filas viejas). El «Retomar» de la barra del pedido de la
  fábrica es otra acción (destrabar el pedido) y no cambia.

### Lo que Teams asume de gs (confirmar con gs-agui)

1. Mismo `runId` ya TERMINADO + `messages: []` → `RUN_STARTED` + `RUN_FINISHED` de ese run (con
   `result`, `metadata`, `usage`), no un run nuevo. `runId` desconocido → 404 `run_not_found`.
2. Reconectar/adoptar = contrato estándar: `MESSAGES_SNAPSHOT` (ids `<runId>:a<n>`; de ahí sale el texto ya
   cerrado, o la cola de uno que se cerró durante el corte) y luego lo abierto re-emitido acumulado.
3. `ghosty.reply_to.messageIds` / `ghosty.injected.messageId` = los `messages[].id` que manda Teams
   (el id numérico del mensaje en Teams cuando hay steer).
4. Cada `TOOL_CALL_END` va seguido de su `TOOL_CALL_RESULT` (con `metadata.error` si falló).
5. `forwardedProps` que manda Teams: `configGroupId, sender, appendSystemPrompt, toolToken, toolsUrl,
   wakeUrl, wakeRef, boardId, model, nativeSubagents, childProfile, steer, injectOnly, cancel,
   permissions:"auto"`.
6. Cancel = POST con `runId` nuevo, `messages: []` y `forwardedProps.cancel`; Teams ignora la respuesta.
7. Plan de TodoWrite en `TOOL_CALL_ARGS`; subagentes en `state.subagents.tasks[]` con
   `lastTool` = «tool · detalle».

## 5. Corte (orden fijado por team-lead, 18-oct)

1. gs despliega `POST /api/v2/fleet-agents/:id/agui` (rama `teams-agui`, aditiva sobre main; conviven
   `turns`/`message-stream`).
2. Teams pasa contra prod y, con aviso de team-lead, se despliega (rebake/hot-deploy según
   `docs/DEPLOY.md`; respaldo antes). Los turnos en vuelo los adopta el Teams nuevo por `/agui` con su
   `durable_turn_id` (gs reconoce los `teams:<uuid>` de `/turns`).
3. El día del corte de gs, Teams ya está migrado.
