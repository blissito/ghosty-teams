# Ghosty Studio — handoff para quien trabaja desde Ghosty Teams

> Doc cross-repo. Estás en el repo de **Ghosty Teams** (`~/ghosty-chat`, la app de
> chat). Este documento explica **Ghosty Studio**, el control-plane + IdP del que
> Teams depende. El doc espejo (Teams explicado desde Studio) está en el repo de
> Studio: `~/ghosty-studio/docs/GHOSTY-TEAMS.md`.

## Qué es

**Ghosty Studio** es el **control-plane + IdP (Identity Provider)** del ecosistema
Ghosty. Es la marca y la control-surface: gestiona identidad (login con Google),
el registro de workspaces de Teams, y el provisioning de sus bases de datos. Vive
en `www.ghosty.studio`. Teams (`*.teams.ghosty.studio`) vive *sobre* Studio.

## Stack

- **React Router 7** (framework mode, loaders/actions, `app/routes/*`).
- **Prisma** sobre **SQLite** (`datasource db { provider = "sqlite" }`). La ruta de
  la DB viene de `env("DATABASE_URL")`: en la caja microVM es `/app/ghosty.db`, en
  Fly es `file:/data/ghosty.db` (ver `fly.toml`). El repo también puede correr en
  Fly, pero la instancia de producción del ecosistema es la caja.
- Login con **Google** (`app/routes/auth.google.start.tsx` / `auth.google.callback.tsx`).

## Modelos Prisma clave (`prisma/schema.prisma`)

```prisma
model User {
  id              String   @id @default(cuid())
  email           String   @unique
  plan            String   @default("FREE")   // FREE | PRO | ENTERPRISE (límite de workspaces)
  emailVerifiedAt DateTime?                    // gracia de 15 días si null
  ownedWorkspaces Workspace[] @relation("WorkspaceOwner")
  memberships     Membership[]
  // ...easybitsApiKey, providerCreds, etc.
}

model Workspace {
  id          String  @id @default(cuid())
  slug        String  @unique                 // subdominio: <slug>.teams.ghosty.studio
  namespace   String  @unique                 // namespace sqld del tenant (24-hex)
  ownerUserId String
  tier        String  @default("shared")      // 'shared' (caja multitenant) | 'dedicated' (enterprise, futuro)
  status      String  @default("ready")       // 'provisioning' | 'ready' | 'failed'
}

model Membership {                            // RBAC genérico (no solo workspaces)
  userId       String
  resourceType String                         // 'WORKSPACE' | 'GROUP' | 'SERVER' | 'BOT'
  resourceId   String
  role         String                         // 'OWNER' | 'ADMIN' | 'VIEWER'
  @@unique([userId, resourceType, resourceId])
}
```

Notas verificadas contra el código:
- El plan de límite vive en `User.plan` (no en `Workspace`). `Workspace.tier` es la
  clase de hosting (`shared`/`dedicated`).
- `Membership` es RBAC genérico: para workspaces se usa `resourceType="WORKSPACE"`,
  `role="OWNER"`. El comentario del schema lista los roles como `OWNER/ADMIN/VIEWER`;
  `listUserWorkspaces` cae a `VIEWER` si no encuentra rol. (No existe un rol
  "MEMBER" en el enum.)

## Endpoints que Studio EXPONE a Teams

Todos firmados HMAC-SHA256 con el secreto compartido `GHOSTY_PARTNER_SECRET`,
ventana `ts ± 300s`, `timingSafeEqual` para comparar firmas. `sub` = `User.id` de
Studio (la llave de identidad que viaja en todo el ecosistema).

### `GET /identity/connect?o&ts&sig&return` — handshake de login
`app/routes/identity.connect.tsx`

- Verifica `sig = HMAC(`${ts}.${o}`)`; el `origin` `o` debe ser
  `teams.ghosty.studio` o `*.teams.ghosty.studio` (localhost en dev).
- Si no hay sesión gs → rebota por Google login preservando el connect como `next`.
- Si hay sesión → firma la identidad y redirige (302) a `<o><return>?payload&sig`:
  - `payload` = base64url de `{ sub, email, name, avatar, ts }` (hoy
    `name = email.split("@")[0]`, `avatar = ""`).
  - `sig = HMAC(payload)`.
  - El `return` se resuelve contra `o` y debe quedarse en el mismo origen.

### `GET /internal/workspaces/:slug?ts&sig` — resolver slug → namespace
`app/routes/internal.workspaces.$slug.tsx`

- Verifica `sig = HMAC(`${ts}.${slug}`)`.
- Respuesta: `{ namespace, status, tier }`. (403 firma inválida, 404 si no existe.)
  No expone el registro completo, solo lo mínimo para enrutar el tenant.

### `GET /internal/user-workspaces?sub&ts&sig` — workspaces del usuario
`app/routes/internal.user-workspaces.tsx`

- Verifica `sig = HMAC(`${ts}.${sub}`)`.
- Respuesta: `{ workspaces: [{ slug, role, tier, status }] }` (vía
  `listUserWorkspaces(sub)`). No expone namespaces, solo slug/role/tier/status.

## Provisioning de workspace — `app/lib/workspaces.server.ts`

`createWorkspace({ ownerUserId, slug })` (`workspaces.server.ts:92`):

1. Normaliza el slug (DNS-safe, 2-40, minúsculas/números/guiones, no reservado:
   `www/teams/app/api/admin/internal/static/assets`).
2. Chequea el límite por plan del owner: `FREE=1, PRO=5, ENTERPRISE=100`
   (`workspaceLimitFor`).
3. Genera `namespace` = 24-hex aleatorio.
4. **Crea el namespace sqld + corre schema + seed**: `sqldCreateNamespace(ns)`,
   luego `GC_SCHEMA` (tablas `gc_*` canónicas de Teams, espejo de
   `~/ghosty-chat/src/server/schema.server.ts`) y `GC_SEED` (canales `general` /
   `random` / `soporte`), todo vía `sqldExec` tolerando errores idempotentes
   (`duplicate column|already exists`). Si algo falla, best-effort
   `sqldDeleteNamespace(ns)`.
5. **Registra** `Workspace{slug, namespace, ownerUserId, tier:"shared",
   status:"ready"}` + `Membership{resourceType:"WORKSPACE", role:"OWNER"}`.

NO levanta ninguna caja: la caja permanente multitenant de Teams ya corre y
resuelve el namespace por subdominio.

### Cliente sqld — `app/lib/sqld.server.ts`

Studio administra los namespaces sobre el sqld self-hosted (data plane = queries,
lo hace la caja Teams directo):

- `sqldCreateNamespace(ns)`: `POST {SQLD_ADMIN_URL}/v1/namespaces/:ns/create`
  (409 = ya existe → ok).
- `sqldDeleteNamespace(ns)`: `DELETE {SQLD_ADMIN_URL}/v1/namespaces/:ns`
  (404 → ok).
- `sqldExec(ns, sql, tolerate?)`: `POST {SQLD_URL}/v2/pipeline` con header
  `x-namespace: ns`; `tolerate` (regex) traga errores idempotentes.
- Defaults del source: `SQLD_URL=http://127.0.0.1:8080`,
  `SQLD_ADMIN_URL=http://127.0.0.1:9090` — env-driven, sobre-escritos en la caja
  por los valores desplegados (ver Infra común).

## Deploy

- Script: `~/sandbox-host/scripts/deploy_ghosty_studio.sh` — **hot-deploy** (sin
  rebake): `npm run build` local → tar de `build/` → se sube a la caja →
  `systemctl restart ghosty-studio`. Para cambios de deps/prisma, usar
  `rebake_ghosty_studio.sh`.
- Ruta de acceso: **SSH al host OVH** (`root@54.38.94.14`) y desde ahí al **daemon
  de sandbox-host** (`http://127.0.0.1:8080`): `POST /v1/sandbox/:sid/files/write`
  + `POST /v1/sandbox/:sid/exec`. La caja corre en un microVM Firecracker; **no hay
  SSH directo al microVM**, se entra por el exec/files API del daemon.
- Secrets garantizados (append-if-missing): `GOOGLE_LOGIN_*`, `MAILMASK_*`. NO pisa
  `SESSION_SECRET`.
- Verificación pública final: `https://www.ghosty.studio/`.

## La caja

- Template: `ghosty-studio`. Name: `ghosty-studio-control-surface`.
- Unit systemd: `ghosty-studio.service`. App en `/opt/ghosty-studio`.

## Infra común (host, sqld, ingress)

- Host OVH KS-5: `54.38.94.14`.
- **sqld** self-hosted (libsql-server): pipeline en `172.20.0.1:8100`
  (header `x-namespace`) + admin en `:9100` (namespace por tenant). Studio crea/
  borra namespaces (admin); Teams hace queries (pipeline).
- **Caddy** ingress con wildcard TLS `*.teams.ghosty.studio` (ZeroSSL). El daemon
  sandbox-host resuelve el dominio de cada caja por metadata `domain:<host>`.

## Relación con Teams (resumen)

Studio es la **fuente de verdad de identidad y de workspaces**; Teams es la app de
chat que consume esos servicios firmados. Teams no persiste usuarios globales ni el
mapa slug→namespace: los pide a Studio. La data del chat vive en el namespace sqld
del tenant (tablas `gc_*`), separada de la DB SQLite/Prisma de Studio.
