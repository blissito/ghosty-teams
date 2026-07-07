# Contrato de agentes — media de dos vías + streaming (v1)

> Confirmado 2026-07-07. Ancla de coordinación entre **GTeams** (`ghosty-chat`, este repo),
> **EasyBits** (`~/easybits`, endpoints fleet + docs/files) y el **otro agente** que construye
> creación/visualización de docs. Objetivo doble:
>
> 1. **Cubrir TODA la superficie de media en dos vías** — entrega (usuario→agente) y recepción
>    (agente→usuario) de audio, imagen, video, docs de todo tipo y archivos no reconocidos.
> 2. **Estándar de industria** — el wire se alinea con **A2A (Agent2Agent, Linux Foundation)**,
>    que a su vez espeja los content-blocks multimodales de Anthropic/OpenAI/Google, para conectar
>    no solo la flota EasyBits sino cualquier agente promedio de la comunidad. Prioridad de esta
>    sesión: nuestros agentes de marca/flota primero.
>
> Decisiones tomadas: **A2A transport completo** · **transporte de media híbrido `uri`+`bytes`** ·
> **streaming first-class** (pedacito a pedacito, la experiencia más instantánea) · **se puede
> modificar EasyBits** donde haga falta.

---

## 0. TL;DR del modelo

Todo mensaje (en ambas direcciones) es una lista de **Parts** tipadas por **MIME**:

```jsonc
// A2A Message
{
  "kind": "message",
  "role": "user",            // "user" (GTeams→agente) | "agent" (agente→GTeams)
  "messageId": "…",
  "contextId": "…",          // = groupId (conversación/memoria por-agente)
  "parts": [
    { "kind": "text", "text": "@ghosty resume el acta y pásalo a PDF" },
    { "kind": "file", "file": {
        "name": "acta.pdf", "mimeType": "application/pdf",
        "uri": "https://…firmado…?exp=…"        // grande → uri firmada TTL corto
    }},
    { "kind": "file", "file": {
        "name": "nota.ogg", "mimeType": "audio/ogg",
        "bytes": "<base64>"                       // pequeño (<256KB) → bytes inline
    }},
    { "kind": "data", "data": { /* nuestro sobre de contexto, ver §4 */ } }
  ]
}
```

**Una sola forma (`FilePart` + `mimeType`) cubre audio, imagen, video, docs y lo desconocido.**
Lo no reconocido cae en `application/octet-stream` sin caso especial. El MIME es la llave: el
agente decide qué hacer (visión nativa para `image/*`, STT para `audio/*`, `Read` para `application/pdf`,
etc.). No hay ramas por-tipo en el wire — solo MIME.

Lo que el agente **produce** viaja como **Artifact** (también `parts[]`), en **streaming**:

```jsonc
// A2A TaskArtifactUpdateEvent (SSE, pedacito a pedacito)
{ "kind": "artifact-update", "taskId": "…",
  "artifact": {
    "artifactId": "…", "name": "Resumen del acta",
    "parts": [
      { "kind": "file", "file": {
          "name": "resumen.pdf", "mimeType": "application/pdf",
          "uri": "https://…easybits…/s/<slug>" }}
    ]
  },
  "append": false, "lastChunk": true }
```

---

## 1. Transporte y streaming (first-class)

El streaming es la **espina**, no un extra. La experiencia objetivo es token-by-token +
artefactos que aparecen conforme se generan.

### 1.1 Wire (A2A)

- **Descubrimiento**: cada agente webhook publica un **Agent Card** en
  `GET {baseUrl}/.well-known/agent-card.json` (declara `capabilities.streaming: true`, `skills[]`,
  `defaultInputModes`/`defaultOutputModes` con los MIME que acepta/emite).
- **Turno con streaming**: `POST {baseUrl}` JSON-RPC 2.0 `method: "message/stream"` →
  respuesta **SSE**. El stream emite, en orden:
  - `TaskStatusUpdateEvent` (`kind:"status-update"`) — cambios de estado + **deltas de texto**
    (el mensaje parcial del agente en `status.message.parts[]`, con `append:true` para chunk).
  - `TaskArtifactUpdateEvent` (`kind:"artifact-update"`) — artefactos producidos, con `append` /
    `lastChunk` para artefactos grandes que llegan por pedazos.
  - evento `final:true` cierra el task.
- **Turno sin streaming** (fallback / clientes simples): `method: "message/send"` → un `Task`
  (o `Message`) completo. Todo agente A2A DEBE soportar `message/send`; `message/stream` es
  opcional pero **requerido para nuestros agentes de flota**.
- **Auth** (webhook): header `Authorization: Bearer <secret-por-agente>` **+** firma HMAC
  `X-Signature: v0:<ts>:<hmac_sha256(secret, "v0:"+ts+":"+rawBody)>`. Rechazar si `|now-ts| > 5min`.
  (Fleet usa el bearer del `fleetAgent.token` que ya tenemos.)

### 1.2 Espina interna de GTeams (bus realtime)

El SSE del agente se **relaya** al cliente sobre el bus in-VM (`src/server/bus.server.ts`) para
que se renderice en vivo. Eventos nuevos del bus (ver §5):

- `message:delta` — append de un chunk de texto a un mensaje del agente ya visible.
- `artifact:new` / `artifact:update` — el artefacto aparece/actualiza su card (abre el panel).

Flujo (ver `askAgent` en `src/server/chat.ts`):
1. Se crea el **mensaje-cáscara** del agente (body vacío) → `message:new` reemplaza el "pensando…".
2. Por cada chunk del SSE → `message:delta` (el cliente hace `patchMessage(id, body+chunk)`).
3. Al `done` → se persiste el body final (`editMessage`) y se materializan los artefactos
   (`artifact:new`). La durabilidad vive en `gc_messages`/`gc_artifacts`; el bus es solo la señal.

---

## 2. Cobertura de media (la tabla de la verdad)

| Familia MIME            | Entrega (usuario→agente)                          | Recepción (agente→usuario)                                |
|-------------------------|---------------------------------------------------|-----------------------------------------------------------|
| `image/*`               | FilePart → **visión nativa** (bytes al disco del worker, `Read`) | FilePart → thumbnail inline / visor en panel   |
| `audio/*`               | FilePart → **STT** (transcribe si no hay texto)   | FilePart → player inline                                  |
| `video/*`               | FilePart (uri) → el agente decide (frame/transcribe) | FilePart → player en panel                             |
| `application/pdf`       | FilePart → `Read`                                  | Artifact `file` → visor PDF en panel                     |
| doc EasyBits (colab)    | FilePart / DataPart ref                            | Artifact `doc` → editor colaborativo embebido (co-edición)|
| `application/*` (office, zip…) | FilePart (uri)                              | Artifact `file` → card de descarga + preview si aplica    |
| `application/octet-stream` (desconocido) | FilePart (uri) — **sin caso especial**   | Artifact `file` → card genérica de descarga               |

Regla: **el MIME manda**. Nada se cae por no estar en una lista blanca — lo desconocido siempre
tiene un camino (uri + card de descarga).

---

## 3. Transporte de bytes (híbrido `uri` + `bytes`)

Los objetos de adjunto son **privados** en EasyBits (Tigris), servidos hoy por el proxy
autenticado `GET /api/attachment/:id` que re-firma un `readUrl` (TTL ~1h). Para entregárselos a un
agente:

- **Grande** (≥ umbral, p.ej. 256KB) o `video/*` → `FilePart.file.uri` = **URL firmada de TTL
  corto** (objetivo ~15 min), minteada por demanda vía `mintReadUrl(fileId)`. El agente hace un
  `fetch` puntual. TTL corto acota la exposición de la URL temporal.
- **Pequeño** (< umbral) → `FilePart.file.bytes` = base64 inline. Self-contained, sin fetch extra,
  ideal para thumbnails / notas de voz cortas.
- **Flota** (EasyBits interno) → además puede recibir un **`file_id` resoluble** internamente (sin
  exponer URL pública), vía DataPart/campo dedicado; la flota resuelve contra la Files API con el
  token del owner.

El umbral y el TTL son constantes de configuración (`MEDIA_INLINE_MAX_BYTES`, `SIGNED_URI_TTL_S`).

---

## 4. El sobre de contexto (DataPart)

Además de las Parts de media, GTeams adjunta **un `DataPart`** con el contexto que un agente rico
necesita (espeja el "contrato webhook rico" de [[agents-admin]]):

```jsonc
{ "kind": "data", "data": {
  "v": 1,
  "agent":   { "handle": "ghosty", "name": "Ghosty" },
  "sender":  { "name": "Bliss" },
  "scope":   { "type": "room"|"dm"|"thread", "roomSlug": "…", "threadId": 123, "dm": null },
  "systemPrompt": "persona por-agente (opcional)",
  "groupId": "ghosty-chat-<handle>-<slug>-<parent|flow>"   // == contextId (memoria por-agente)
}}
```

`groupId` **incluye el handle** del agente: cada agente tiene su propia conversación/memoria en
EasyBits (sin esto dos agentes en el mismo hilo se contaminan — bug raíz documentado en
[[agents-admin]]).

---

## 5. Cambios por repo (implementación, pedacito a pedacito)

### GTeams (`ghosty-chat`) — este repo
- **Slice 1 (streaming spine) — EN CURSO esta sesión.** `bus.server.ts`: evento `message:delta`.
  `agents.server.ts`: `callAgentBackendStream(agent, ctx, onChunk)` → fleet vía `POST
  /api/v2/fleet-agents/:id/message-stream` (SSE `chunk`/`done`/`error`). `chat.ts askAgent`:
  cáscara → deltas → finalizar. Cliente `c.$slug.tsx`: handler `message:delta` (`patchMessage`).
- **Slice 2 (entrega de media).** `askAgent`/`postMessage` reenvían los `attachments` del usuario
  como **FileParts** (mint de `uri` firmada TTL corto vía `mintReadUrl`; bytes si < umbral). Hoy
  los adjuntos **no llegan** al agente — hueco total.
- **Slice 3 (recepción estructurada).** Reemplazar el regex-scraping de URLs (`detectArtifact`)
  por consumo de **eventos `artifact-update`** del SSE → `artifact:new`/`artifact:update` en el bus.
  `detectArtifact` queda solo como fallback para agentes viejos que aún mandan URL en el texto.
- **Slice 4 (webhook A2A + community).** Cliente A2A completo para `kind:"webhook"`: leer Agent
  Card, `message/stream` JSON-RPC/SSE, firma HMAC. (Prioridad: después de flota; no hay webhook
  agents reales aún.)

### EasyBits (`~/easybits`) — se puede modificar
- **Ya existe** (reusar): `POST /api/v2/fleet-agents/:id/message-stream` (SSE `chunk`/`done`),
  y superficie de media inbound `image{base64,ext}` / `audio{base64,mimeType}` / `mediaUrl`
  (visión nativa + STT) en `routeMessage` (`app/.server/core/fleetAgentOperations.ts`).
- **Slice E1 (entrada A2A).** Extender `InboundMessage` para aceptar `parts[]` (A2A) y normalizar
  internamente a image/audio/mediaUrl/doc por MIME → cubre video, pdf, docs y `octet-stream`, no
  solo image/audio. Mantener los campos legacy por compat.
- **Slice E2 (salida estructurada).** `message-stream` emite eventos **`artifact`** (A2A
  `artifact-update`) cuando el turno produce un doc/archivo, en vez de depender de que el agente
  escriba la URL en el texto. `routeMessage` gana un `onArtifact` junto al `onChunk`.
- **Slice E3 (Agent Card flota).** Publicar Agent Card por agente de flota → interop A2A hacia
  afuera (que otros clientes A2A hablen con nuestra flota).

---

## 6. Compatibilidad y no-regresión

- Los agentes de flota existentes siguen funcionando: el `/message` bloqueante queda como fallback;
  `message-stream` es el camino preferido. `detectArtifact` (URL en texto) permanece como red de
  seguridad hasta que Slice E2 esté en prod.
- Un agente que solo entiende texto recibe las Parts de texto y (si no declara MIMEs de entrada en
  su Agent Card) puede ignorar las FileParts — degradación limpia, nunca error.
- Nada rompe si EasyBits/Tigris fallan: mint de uri y artefactos son best-effort (el mensaje
  queda normal), igual que hoy.

Ver [[agents-admin]] (contrato webhook rico, persona por-agente), [[media-surface-plan]]
(superficie de artefactos en panel), [[phase4-longtail]] (Files API / adjuntos EasyBits).
