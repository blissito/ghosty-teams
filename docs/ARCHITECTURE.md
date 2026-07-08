# Ghosty Teams — Arquitectura

Chat de equipo estilo Slack (rooms + hilos) con **agentes tagueables** (`@ghosty`,
`@handle`), **multitenant** y **cloud-native**: el compute es fungible (VMs
Firecracker desde un template inmutable), el estado vive en **EasyBits** (DB
libSQL), y la identidad + el registro de teams viven en **Formmy**.

> Estado (2026-07-04): backbone (ingress + login + selector + provisioning)
> desplegado; ver [Estado](#estado) al final para qué está vivo vs pendiente.

---

## 1. Las tres capas

```
┌─────────────────────────────────────────────────────────────────┐
│  FORMMY  (formmy-v2 en Fly · formmy.app / teams.formmy.app)       │
│  · Identidad (login Google + popup de identidad para el chat)     │
│  · Registro de teams  → modelo Team + membresía vía Permission    │
│  · INGRESS teams.formmy.app  → proxy estable → VM del team         │
│  · Fábrica de provisioning (crea VM + DB por team)                │
└───────────────┬─────────────────────────────────────────────────┘
                │ proxya (x-ghosty-origin) + provisiona (API v2)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  EASYBITS  (www.easybits.cloud)                                   │
│  · Sandboxes (microVMs Firecracker) desde template `ghosty-chat`  │
│  · DB libSQL: una DB AISLADA por team (namespace propio)          │
│  · Fleet agents (el cerebro @ghosty) vía OAuth2 del owner         │
└───────────────┬─────────────────────────────────────────────────┘
                │ una VM por team, corre el app
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  GHOSTY TEAMS INSTANCE  (TanStack Start, una por team)            │
│  · El chat: rooms, hilos, multi-agente, PWA, push                 │
│  · Estado → su DB EasyBits (gc_* tables)                          │
│  · Login → popup de identidad de Formmy                           │
│  · Wizard → conecta el EasyBits del owner (adopta la caja)        │
└─────────────────────────────────────────────────────────────────┘
```

- **Repos**: `~/formmy_rrv7` (Formmy), `~/ghosty-chat` (el app del chat),
  `~/easybits` (plataforma), `~/sandbox-host` (host Firecracker en OVH KS-5).

---

## 2. Dominio estable + ingress (`teams.formmy.app`)

El problema: cada VM tiene una URL efímera (`sb-xxx.sandboxes.easybits.cloud`)
que **churnea en cada rebake**. La solución: un **dominio estable** delante.

- **DNS**: `teams.formmy.app` → CNAME → `formmy-v2.fly.dev` (+ cert Fly). **Un
  solo registro, nunca cambia.** No hay DNS por-caja.
- **Ruteo a la caja** = capa de app, NO DNS. El proxy (`server/server.ts`)
  resuelve por request: `cookie gt_team → Team.instanceUrl` (cacheado 30s) y
  reenvía. Cuando la VM se recrea, solo cambia ese campo en la DB.
- **Proxy a nivel de host** (no subpath): assets/`/api`/server-fns resuelven
  contra `teams.formmy.app` y se reenvían tal cual → nada de rutas rotas. El
  `sb-xxx` queda **interno, nunca lo ve el user**.
- Sin cookie `gt_team` → 302 a `/teams` (**selector**). Login/assets/api pasan
  a Formmy (passthrough).
- **Gate de membresía (seguridad)**: el cookie `gt_team` es un bearer sin binding
  al usuario (Max-Age 30d). Antes de proxyar una **navegación** (GET `text/html`)
  a la caja de un team, el ingress decodifica la `__session` de Formmy (domain
  `.formmy.app` → llega al subdominio) y verifica que el user sea **miembro** de
  ese team (dueño o `Permission` TEAM activa, espejo de `getMyTeams`). Si no → se
  limpia el cookie y va a **su** selector. Sin esto, un `gt_team` heredado (mismo
  browser, otra cuenta) metía al intruso a la caja ajena (la caja hace SSO
  silencioso y lo daba de alta como miembro). Fail-closed; cache 30s por
  `(slug|email)`.

### Beneficios del dominio estable
- **PWA instalable durable**: el ícono no se rompe en rebakes (origin fijo).
- **Push sobrevive rebakes**: las subscriptions viven en el origin estable.
- **Un solo PWA para todos tus teams** (selector por cookie).
- **Link permanente** para invitaciones.

---

## 3. Login (por el dominio estable)

El chat se autentica con el **popup de identidad de Formmy** (no Google directo).
Tres candados que hubo que resolver para que funcione detrás del proxy:

1. **Origin correcto**: el app deriva su origin de headers, no de `APP_URL`.
   Detrás del proxy, EasyBits **reescribe** `x-forwarded-host` (→ `sb-xxx`), así
   que el ingress manda un header custom **`x-ghosty-origin: teams.formmy.app`**
   que EasyBits no toca; el app lo lee primero (`src/origin.server.ts`,
   `src/server/auth.ts`).
2. **Allowlist del partner**: `teams.formmy.app` debe estar en `allowedOrigins`
   del partner `ghosty-chat` (`~/formmy_rrv7/server/channels/partners.server.ts`).
3. **Cookie de sesión** de Formmy = `domain: .formmy.app` (para que el selector
   reconozca tu login en el subdominio). El `gc_session` del chat es host-only de
   `teams.formmy.app`.

---

## 4. Multitenancy — modelo de datos

- **Formmy** es el registro `usuario → teams`:
  - `Team` (Prisma): `{ userId (owner), name, slug, instanceUrl, sandboxId, dbNamespace, failReason }`.
    Un Team = una instancia de Ghosty Teams.
  - **Un team propio por user** (regla de producto): un usuario tiene EXACTAMENTE
    un team propio y NO puede lanzar más. Ve otros SOLO si lo invitan. El selector
    muestra `owned` (uno) + `invited`; el botón "Lanzar" solo si no tiene propio.
    La acción `ensure` es idempotente (ya-listo→abre, existe-sin-instancia→revive,
    no-existe→crea) — reemplaza los viejos `create`/`retry` que apilaban duplicados.
  - **Membresía** = `Permission` con `resourceType: TEAM` (reusa el sistema de
    colaboradores de Formmy: invitación por email + token + rol ADMIN/EDITOR/VIEWER).
  - `getMyTeams(userId, email)` = owned + member-via-Permission → alimenta el
    **selector** (propios + invitados) y el routing.
- **Cada team = su propia DB EasyBits** (namespace libSQL aislado). Todas las
  tablas `gc_*` viven en la DB de ESE team → aislamiento real.
- **Identidad global** = el `sub` de Formmy. Un mismo user tiene una fila
  `gc_users` **por-team**, con su `isOwner`/`handle`/membresías/push **por-team**.
  Puede ser **owner de un team y miembro (invitado) de otros**.

---

## 5. Provisioning + adopción (el modelo de cuenta)

**Cloud-native**: la caja es compute fungible; el owner es dueño vía el wizard.

1. **Team nuevo** (selector → "Lanzar"):
   `provisionTeamInstance(slug)` (`~/formmy_rrv7/app/.server/provision.server.ts`),
   con la **key de PLATAFORMA** (cuenta fixtergeek, env `GHOSTY_PLATFORM_EB_KEY`):
   - crea la **DB aislada** del team → migra schema `gc_*` + seed de 3 rooms;
   - spinnea la **VM** del template `ghosty-chat` → espera running;
   - inyecta `secrets.env` (key plataforma + `EASYBITS_DB_ID` del team +
     `SESSION_SECRET` único + partner secret + VAPID);
   - expone `:3000` → guarda `instanceUrl/sandboxId/dbNamespace` en el `Team`.
   La caja nace **"huérfana/nuestra"** (cuenta plataforma).
2. **El user entra al chat** → primer login = **owner** → **wizard**.
3. **El wizard conecta su EasyBits vía OAuth2** → **eso ADOPTA la caja a su
   cuenta** (deja de ser huérfana). Es el **único conector**.
4. **Nadie conecta** → huérfana → el **reaper** la mata (idle/TTL).
5. **Team existente** (propio o invitado) → su caja ya está en la **cuenta
   correspondiente** → el selector proxya a su `instanceUrl` (o se resume ahí).

> Por qué el wizard y no OAuth antes: para provisionar en TU cuenta se
> necesitaría tu token antes de que exista el chat. En cambio: plataforma
> spinnea (fungible) y **el wizard adopta** — un solo momento de conexión.

**Idempotencia + cleanup** (evita apilar teams y fugar cupo de la cuenta
plataforma):
- **"Lanzar" reusa un team propio incompleto** (sin `instanceUrl`) en vez de
  crear uno nuevo por click → un launch fallido ya no deja fantasmas en
  "Reintentar". Revive sobre su DB si ya la tenía; solo crea uno nuevo si no hay
  ninguno a medias.
- **`spinAndExpose` destruye la caja best-effort si la provisión falla tras
  crearla** (running/exec/expose). Sin esto, una caja creada-pero-no-expuesta
  quedaba viva contando en `inUse = live + suspended` de la cuenta plataforma
  hasta el hardTtl (7d) → suficientes fallos llenaban el cupo y **nadie más podía
  lanzar**.

---

## 6. El app del chat (`~/ghosty-chat`, TanStack Start)

- **Modelo Slack**: room = flujo; hilos nacen de un mensaje (`gc_messages.parent_id`).
- **Estado en EasyBits DB** (`src/db.server.ts`, cliente HTTP libSQL). Compute
  stateless.
- **Cache client-side** (`useCachedQuery` + Maps de módulo): reabrir hilo/room =
  instantáneo; `rev` unificado revalida en background sin glitch.
- **Multi-agente**: `gc_agents` (fleet o webhook) + el `@ghosty` implícito del
  wizard. Typeahead lista agentes + usuarios. Routing por `@handle`; los hilos
  continúan con el agente del root. (`src/agents.server.ts`, `src/server/agents.ts`).
- **Menciones a usuarios + push**: `@handle` de un user → Web Push (VAPID). Subs
  en `gc_push_subs`; SW handlers en `public/sw.js`.
- **PWA**: `public/manifest.webmanifest` + `sw.js` + `InstallAppBanner`
  (Chrome/Android/desktop = prompt nativo; iOS = tutorial). Iconos Ghosty.
- **Rooms CRUD** público/privado + miembros (typeahead de miembros existentes).
- **Iconos Lucide** en todo el chrome; el 👾 del feed de actividad del agente se
  conserva (señal de producto).

### Template inmutable (deploy del app)
- Buildeado en el host OVH KS-5: `templates/ghosty-chat/Dockerfile` (node:22) →
  app horneada en `/opt/ghosty-chat` (NO `/app`, que es volumen writable) →
  `build_template.sh` → ext4. `docker build --provenance=false --sbom=false`.
- Secrets NO horneados: `/app/secrets.env` inyectado al provisionar.
- Rebake = rsync src al host → docker build → build_template.sh → crear VM nueva.

---

## 7. Estado

**Vivo (prod):**
- Ingress `teams.formmy.app` (proxy) + selector (`/teams`, propios + invitados).
- Login por dominio estable (x-ghosty-origin + allowlist + cookie `.formmy.app`).
- Provisioning + "Lanzar nuevo team" (VM + DB aislada, key plataforma).
- El app: cache, multi-agente, PWA, push, menciones, rooms.

**Pendiente:**
- **`ensureResume` + idle-suspend** de la caja (como los workers/cajas de voz):
  hoy las cajas son `persistent` (always-on). Requiere que el ingress despierte
  la VM al request (`resume` + `touch`). Ver §8.
- **Adopción formal**: reasignar `ownerId` del sandbox/DB a la cuenta del owner
  al conectar el wizard (hoy la conexión liga tokens/agente; el `ownerId` crudo
  sigue en plataforma).
- **Push centralizado** al origin estable (VAPID + subs a nivel Formmy, no per-VM).
- **Alias estable de EasyBits** por team → `instanceUrl` no cambia en rebakes.
- **Media estilo Claude Cowork**: subida → artefacto previsualizador → editor,
  reusando storage/render/editores de EasyBits (no un stack paralelo).

---

## 8. Idle-suspend (diseño pendiente)

El reaper de sandbox-host es por **TTL fijo, no por idle de actividad**;
`persistent:true` lo salta (nunca muere por idle). Para idle-suspend real (como
pediste: suspende por idle, despierta al usar, resetea con uso) hace falta un
**wake-proxy L7**: el ingress `teams.formmy.app` hace `ensureResume` + `touch`
en cada request → despierta la VM suspendida (~1s), resetea el idle; el reaper
suspende (snapshot) por idle y destruye tras `hardTtl`. Las primitivas
`Suspend`/`Resume` (snapshot Firecracker) ya existen en sandbox-host; falta el
wake reactivo en el ingress (hoy es DNAT L4, no despierta al request).
