# Deploy / Rebake — Ghosty Teams

El app corre en microVMs Firecracker desde un **template inmutable** `ghosty-chat`
horneado **en el host OVH KS-5** (ARCHITECTURE §6). Los secrets **no** se hornean:
se inyectan en `/app/secrets.env` al provisionar. El provisioner de Formmy
(`formmy_rrv7/app/.server/provision.server.ts`) sólo **consume** el template vía
`POST /api/v2/sandboxes {template:"ghosty-chat"}`; no lo construye.

> **Cada cambio de runtime necesita un rebake para llegar a prod.** No hay
> hot-reload en las VMs: sirven el bundle horneado en `/opt/ghosty-chat`.

## Rebake en un comando

```bash
HOST=mi-alias-ovh ./scripts/rebake.sh
```

Hace: build local (sanity `tsc` + `npm run build`) → `rsync` del código al host →
`docker build --provenance=false --sbom=false` → `build_template.sh` (imagen ext4).
No crea VMs ni toca secrets. Ver `scripts/rebake.sh` para variables
(`REMOTE_DIR`, `SKIP_BUILD`).

Después, a mano:
1. **Crear/recrear la VM** desde el template (API EasyBits o "Lanzar nuevo team").
   El provisioning reinyecta `secrets.env`.
2. **Smoke test:** `GET https://teams.formmy.app/api/stream` con cookie
   `gc_session` → `text/event-stream`; postear en un room desde una segunda sesión
   y ver el evento llegar en vivo.

## Migración de schema (dos vías, ya sincronizadas)

Las tablas/columnas nuevas (DMs, reacciones, reads, star/pin/mute, adjuntos,
emojis, topics) llegan a cada team por **dos caminos idempotentes**:

- **Teams existentes** → `ensureSchema()` (`src/server/schema.server.ts`) auto-cura
  aditivo en el primer request (se invoca en `getChannelView` y en `dm.ts`).
- **Teams nuevos** → `GC_SCHEMA` del provisioner es **espejo** de `ensureSchema`
  (los teams nacen completos).

> Al tocar el schema, edita **ambos** lados en sync: `schema.server.ts` (cura) y
> `provision.server.ts` en `formmy_rrv7` (nacimiento).

## Notas de infra

- **Sin deps ni env nuevos** para el realtime: `EventSource` es nativo del browser;
  `ReadableStream`/h3 ya vienen en Nitro. Bake limpio de código.
- **SSE y el ingress:** `teams.formmy.app` es **DNAT L4** → pass-through TCP, no
  bufferea HTTP, así que `/api/stream` fluye. Si algún día se antepone un proxy L7,
  debe desactivar el buffering (el endpoint ya emite `X-Accel-Buffering: no`).
- **TTL del reaper (1800s):** una conexión SSE se corta ~cada 30 min y el cliente
  reconecta + catch-up (`getMessagesSince`) → lossless, con un blip aceptable.
- **Idle-suspend** real (suspende por idle, despierta al request) sigue pendiente:
  requiere un wake-proxy L7 en el ingress (ARCHITECTURE §8).

## Verificación en vivo (bloqueada en dev, se hace en prod)

En dev local **no hay DB** hasta provisionar un team conectando EasyBits, así que
estos paths sólo se validan tras el primer bake:

- Realtime lossless (dos sesiones, corte + catch-up), DMs, reacciones, unread,
  markdown, star/pin/mute, buscador.
- **Fase 3 mobile** (responsive/PWA/teclado): barrido en 375×812 y 390×844.
- **EasyBits:** uploads, adjuntos, emojis custom, refresh de token, y el scope
  `mcp` para la Files API. Si `mcp` no cubre Files, el fallback a
  `EASYBITS_API_KEY` global lo cubre (path probado en Formmy).
