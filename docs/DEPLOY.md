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
./scripts/rebake.sh          # HOST=54.38.94.14, KEY=~/.ssh/id_rsa_ovh por defecto
```

Pipeline real (2 repos + host OVH KS-5), **probado 2026-07-05**:

```
~/ghosty-chat (source) → ~/sandbox-host/templates/ghosty-chat/app → host: docker build → ext4
```

El script hace: sanity local (`tsc`+`build`) → sync del source al template (sin
`package-lock.json`, ver gotcha) → rsync template+`build_template.sh` al host →
`docker build -t localhost/ghosty-chat:latest` → **backup del ext4 vivo** →
`build_template.sh ghosty-chat localhost/ghosty-chat:latest 4096` → smoke con una
VM efímera. **No** recrea VMs ni toca secrets; las VMs corriendo no se afectan.

> ⚠️ **Gotcha del lockfile:** NO copiar `package-lock.json` al template. Un lock
> generado en macOS-arm64 hace que `npm install` en el contenedor linux-amd64
> **omita los binarios nativos** (rolldown/tailwind-oxide) → `MODULE_NOT_FOUND` en
> el build. `package.json` usa `latest`/`nitro-nightly`, así que se resuelve fresco
> por plataforma. `rebake.sh` ya lo excluye.

> ⚠️ **El bake no es atómico:** `build_template.sh` hace `rm -f ghosty-chat.ext4`
> antes de reconstruir. Por eso el script respalda a `.ext4.bak-<fecha>` primero;
> si el bake falla, `mv` el backup de vuelta.

Después, a mano (no automatizado):
1. **Cutover de un team existente** (para que tome el template nuevo). Las VMs
   corriendo siguen con su ext4 viejo hasta recrearse. Para migrar un team ya:
   - **Destruir su caja** en el host: `DELETE http://127.0.0.1:8080/v1/sandbox/<sandboxId>`
     (bearer `SANDBOX_HOST_TOKEN` de `/etc/sandbox-host/.env`).
   - **El owner recarga `teams.formmy.app` (logueado)** → el ingress
     (`formmy_rrv7/server/server.ts`) detecta la caja muerta → `reviveBox()` levanta
     una nueva **del template nuevo** sobre la MISMA DB, actualiza el `Team` y proxya.
     Muestra una *warming page* con auto-refresh ~60-90s. **Ojo:** una petición NO
     autenticada sólo redirige a login → no dispara el revive; tiene que ser el owner.
   - Los teams nuevos nacen con el template nuevo automáticamente.
2. **Verificación funcional** con secrets reales: `GET /api/stream` con cookie
   `gc_session` → `text/event-stream`; postear desde otra sesión y ver el evento
   en vivo. (La VM de smoke da 500 sin secrets — es correcto.)

## Incidente 2026-07-05 (lecciones)

Primer bake Fases 0-4 → prod dio `db 500: Unexpected Server Error`. Causa doble:

- **Migraciones tragadas:** `ensureSchema()` corrió durante un blip de la DB, los
  `ALTER/CREATE` fallaron, se tragaron y quedaron memoizados como hechos → nunca se
  aplicaron (`no such column: archived`). **Arreglado en código** (`ensureSchema`
  reintenta en vez de memoizar el fallo). **Recuperación en sitio** sin perder datos:
  aplicar las DDL **directo al sqld** desde una máquina externa (evita el hairpin):
  `POST https://easybits-db.fly.dev/v2/pipeline` con header `x-namespace:<dbId>` y
  body `{"requests":[{"type":"execute","stmt":{"sql":"..."}},{"type":"close"}]}`.
- **`Unexpected end of JSON input` en el app EasyBits** = recibe body vacío de sqld.
  sqld sano (curl externo 200); el app **dentro de Fly** llama a su propio
  `SQLD_URL=https://easybits-db.fly.dev` (público) → **hairpin de Fly** intermitente.
  Se asentó tras reiniciar sqld+app. **NO cambiar el autostop de `easybits-db`**
  (funciona así por diseño). Diagnosticar con `flyctl logs -a easybits` (busca el
  error real) y `flyctl logs -a easybits-db` (salud de sqld), no adivinando.

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

---

## INCIDENTE 2026-07-06 — team pegado en "Levantando tu team… reviviendo" (perpetuo)

**Síntoma:** teams.formmy.app queda eternamente en la warming page ("Tu caja se durmió;
la estamos reviviendo ~20s"), nunca carga el team.

**Causa raíz (NO era el template):** el registro `Team` en la DB de formmy quedó pegado en
`status='provisioning'`. El ingress (`formmy_rrv7/server/server.ts:271`) hace
`if (team.status === 'provisioning') return sendReviving(res)` **antes** de cualquier
health-check o re-disparo → una vez en 'provisioning', muestra la warming page en CADA
request y **nunca re-dispara `reviveBox`**. No auto-sana. Se llega a ese estado cuando un
`reviveBox` de fondo (`void (async …)`, línea ~310) se INTERRUMPE: pone `status='provisioning'`
(línea 308) y nunca alcanza `status='ready'` (línea 315). Lo detonó la combinación de: (a)
churn de kills de la VM del team, y (b) un **redeploy de formmy-v2** (reinicia el machine →
mata el async de revive en vuelo).

**Verificación (el template estaba SANO):** smoke y una box con secrets reales (dbId correcto
`6a49a3be0d65b77d12dc7536`) devolvían **307** (redirect a login), no 500. EasyBits creaba boxes
OK. La DB del team respondía `SELECT 1`. O sea: plataforma + template + DB sanos.

**Recuperación (runbook):**
1. Confirmar el estado del team (Mongo de formmy, vía `flyctl ssh console -a formmy-v2`):
   `p.team.findUnique({where:{slug:'<slug>'}, select:{status,sandboxId,instanceUrl,dbNamespace}})`.
2. Si `status==='provisioning'` y no avanza → **resetear a `ready`**:
   `p.team.updateMany({where:{status:'provisioning'}, data:{status:'ready'}})`.
   Con status='ready' e `instanceUrl` de una box muerta, el ingress: warmup → `boxDestroyed`
   (proxy responde "not a valid preview host") = true → NO sirve el cadáver → re-dispara
   `reviveBox` → crea box nueva → `status='ready'` + `instanceUrl` nuevo. Recupera solo.
3. Acceso directo a las DBs de team vía EasyBits (la `EASYBITS_API_KEY` de dev = key de
   PLATAFORMA): `GET {EB}/api/v2/databases` (lista todas), `POST {EB}/api/v2/databases/{dbId}/query`
   `{sql,args}`. dbId del team = su `dbNamespace`.

**Lección / hardening pendiente (formmy_rrv7 server.ts):** `status='provisioning'` debería
**auto-sanar** — si `Date.now()-updatedAt` supera un umbral (p.ej. 2 min), tratar como caja
muerta y re-disparar `reviveBox` en vez de mostrar la warming page indefinidamente. Y NO
redeployar formmy-v2 mientras hay revives de team en vuelo (mata el async de fondo).
