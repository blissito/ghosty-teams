# Conectores

Cómo agregar una integración a Ghosty Teams. Hay **dos formas de conectarse** y conviven en
el mismo registro, el mismo panel y el mismo dispatch de tools:

| Forma | Quién | Qué declara |
|---|---|---|
| **OAuth2** | Calendly, Deník, Sentry, GitHub | `oauth` en `ConnectorDef` |
| **Credenciales tecleadas** | Odoo (y Kommo, y los que vengan) | `credentials` en `ConnectorDef` |

Son **excluyentes**: un conector tiene una o la otra, nunca las dos. Hay un test que lo
exige (`registry-forma.test.ts`).

Todo lo que NO es la conexión —listado, panel, compartir, desconectar, descubrimiento de
tools, dispatch, scope— es agnóstico y ya funciona para las dos. El criterio de "conectado"
en todo el repo es `access_token IS NOT NULL`.

---

## Agregar un conector por CREDENCIALES

Tres pasos. No hay un cuarto: no se escriben rutas, ni formulario, ni validación de red.

### 1. La entrada en el registro

`src/server/connectors/registry.ts`:

```ts
{
  id: "kommo",
  name: "Kommo",
  blurb: "Deja que @ghosty trabaje con tus leads y embudos de Kommo.",
  icon: "kommo",              // si no está en connIcon(), cae a Plug y no rompe
  type: "Web",
  status: "available",
  credentials: {
    intro: "Qué va a poder hacer el agente, y qué no.",
    docsUrl: "https://developers.kommo.com/docs/long-lived-token",
    allowHostSuffixes: ["kommo.com"],   // ver «El guard de red», abajo
    fields: [
      { key: "subdomain", label: "Subdominio", type: "text",
        host: true, hostTemplate: "https://{value}.kommo.com" },
      { key: "token", label: "Token de larga duración", type: "password", secret: true },
    ],
  },
}
```

Reglas de los campos, todas con test:

- **Exactamente un `secret: true`.** Va a `access_token`, con el mismo trato que un token
  OAuth: el navegador nunca lo ve. Y se pide como `type: "password"`.
- **Al menos un `host: true`.** Es lo que el servidor va a fetchear, y lo que pasa por el
  guard de red. Sin ninguno, el guard no tendría qué validar.
- `hostTemplate` para proveedores que piden un subdominio en vez de una URL. Se queda con la
  **primera etiqueta DNS** de lo que teclee la persona, así que `acme`, `acme.kommo.com` y
  `https://acme.kommo.com/leads` dan todos lo mismo.
- Todo lo **no secreto** se guarda en `meta` como JSON. **No hay columnas nuevas** que
  agregar: `gc_user_connectors` ya sirve tal cual.

### 2. El módulo

`src/server/connectors/<id>.server.ts`, con dos exports obligatorios y uno recomendado:

```ts
// Prueba las credenciales ANTES de que se guarde nada. Recibe los campos YA pasados por el
// guard de red y NO recibe `sub`: no puede persistir ni saltarse el guard.
// El `error` lo lee un HUMANO en el formulario, así que dice qué corregir.
export async function verifyCredentials(fields): Promise<VerifyResult>

// Lista CONSTANTE (ver «Invariantes»). Prefijo del conector en todos los nombres.
export const tools: ConnectorTool[]

// Recomendado. Sin red: se arma leyendo la fila.
export async function ambientContext(sub, sender, message, dest, opts): Promise<string|null>
```

Para leer la credencial en un handler:

```ts
import { getCredentials, notConnected } from "./credentials.server";

const creds = await getCredentials<MisCampos>(sub, "kommo");
if (!creds) return notConnected("Kommo");
// creds.secret · creds.fields · creds.origin (ya validado) · creds.probe
```

> ⚠️ **No uses `getValidToken`.** Devuelve `null` para todo lo que no sea OAuth, y ese
> `null` es indistinguible de "no conectado": el panel diría **Conectado** mientras el
> agente insiste en que no lo está. Bucle sin salida y sin un solo log.

### 3. La línea en `LOADERS`

`src/server/connectors/impl.ts`:

```ts
kommo: () => import("./kommo.server"),
```

---

## El guard de red (SSRF) — no es opcional

La URL la teclea el usuario y la petición **sale de nuestra red**, la misma que ve
`172.20.0.1:8080`, la API del host de sandboxes. Sin guard, cualquier miembro conecta un
conector apuntando ahí y usa las tools como **proxy HTTP autenticado, con la respuesta de
vuelta al modelo**.

No hay que hacer nada para activarlo: `saveCredentials` lo aplica a todos los campos
`host: true`, y `getCredentials` **revalida el origin en cada lectura** (se guardó hace
meses; el dominio pudo cambiar de dueño).

Para pegarle al proveedor desde un módulo, usa `guardedFetch` — no `fetch` pelado:

```ts
import { guardedFetch } from "./net-guard.server";
const { status, body } = await guardedFetch(creds.origin, "/api/v4/leads", { … });
```

Qué cubre: sólo `https`, allowlist de puertos, rechazo de IP literal (decimal y hex
incluidos) y de `user:pass@`, resolución DNS con **todas** las respuestas validadas contra
los rangos privados (IPv4, IPv6, mapeadas y NAT64), `redirect: "manual"` y tope de tamaño
de respuesta.

- **`allowHostSuffixes`** es la defensa más eficaz cuando el proveedor tiene host fijo
  (Kommo siempre es `*.kommo.com`). Úsalo siempre que puedas; el validador genérico es para
  los que se auto-hospedan, como Odoo.
- **`CONNECTORS_HOST_ALLOWLIST`** (por env, sufijos separados por coma) acota el despliegue
  entero. ⚠️ Ya está en la allowlist de secretos de `deploy_ghosty_teams.sh`; una clave que
  no esté ahí **no se copia y falla en silencio**.
- **`CONNECTORS_ALLOW_HTTP=1`** permite `http` y los puertos de Odoo. **Sólo en dev.**
- ⚠️ **Abierto: DNS rebinding.** El arreglo es pinnear el IP con
  `undici.Agent({connect:{lookup}})`. El atajo que parece equivalente —`fetch` a la IP con
  header `Host`— **rompe SNI y la validación del certificado**; cuesta lo mismo hacerlo bien.

---

## Reglas que valen para los dos tipos

### Los handlers NUNCA lanzan

Devuelven `{ error: "<español accionable>" }`, porque **lo lee el modelo**. Un `403` pelado
lo lleva a inventar excusas; un mensaje que diga qué hacer lo lleva a decírselo al usuario.
Molde completo en `sentry.server.ts` y `odoo.server.ts`.

Y **nada de detalle técnico ajeno**: cuando algo salga mal, mira qué contiene el texto antes
de devolverlo. Odoo, por ejemplo, deja escapar el error crudo de su Postgres **con su IP
interna y su puerto dentro**.

### Invariantes con test

- **`tools` no puede variar por `dest.parentId`** — el listado dentro de un hilo debe ser
  idéntico al del canal (`no-regresion.test.ts`). Por `dest.channelId` sí puede (Sentry lo
  hace con sus alertas). Lo más simple y seguro: una **lista constante**.
- **El orden del listado es contractual** (`scope-listado.test.ts`).
- **Prefijo propio en todas las tools.** No uses `github_`, `task_`, `reminder_`, `form_`,
  `doc_`, `memory_` ni `prospect_`.
- Un prefijo nuevo **no está en `FAMILIAS`** (`tools.server.ts`), así que sólo lo alcanza el
  scope `completo`. Falla cerrado, que es lo correcto: métete ahí a propósito, no de paso.

### Probar contra el proveedor DE VERDAD

Los tests con `fetch` mockeado no ven cómo contesta el servidor real. Casi todos los
proveedores tienen algún endpoint sin autenticar que sirve de banco de pruebas — Odoo
responde `common.version` en `https://www.odoo.com/jsonrpc` sin credenciales.

`scripts/odoo-connector-smoke.mts` es el ejemplo: no pide llaves y ejercita el camino
completo (guard resolviendo DNS de verdad, transporte y traducción de errores). Encontró
tres fugas que 18 tests mockeados daban por verdes.

---

## Cosas que el código no distingue solo

- **Desconectar un conector de credenciales NO revoca.** Sin `revokeUrl` sólo se borra la
  fila local; la llave sigue viva en el proveedor. Es el único caso del sistema, y la
  respuesta lo dice (`sigueViva`). No lo calles en la UI.
- **Compartir una credencial ajena está prohibido.** Un OAuth llega acotado por los scopes
  que concedió el proveedor; una API key hereda **todos** los permisos de su usuario, no es
  revocable desde aquí, y en el otro lado los cambios quedan firmados con su nombre. El
  dueño puede compartir la suya; el owner no puede compartir la de otro.
- **`expires_at` y `refresh_token` van a `NULL`**, jamás a `0`. Una credencial no caduca, y
  un futuro `WHERE expires_at < unixepoch()` mataría todas estas conexiones de golpe.

## Mapa de archivos

| Archivo | Qué |
|---|---|
| `connectors/registry.ts` | el catálogo y los tipos (`ConnectorDef`, `CredentialsDef`) |
| `connectors/impl.ts` | el contrato del módulo y `LOADERS` |
| `connectors/oauth.server.ts` | cliente OAuth genérico — **no lo toques para credenciales** |
| `connectors/credentials.server.ts` | `getCredentials`, `saveCredentials`, `notConnected` |
| `connectors/net-guard.server.ts` | `assertPublicOrigin`, `guardedFetch` |
| `connectors/store.server.ts` | la fila (`gc_user_connectors`), compartir, holders |
| `connectors/tools.server.ts` | `listUserTools`, `runTool`, scope |
| `server/connectors.ts` | server functions: conectar, desconectar, compartir, listar |
| `components/SettingsContent.tsx` | el panel y `CredentialsDialog` (genérico) |

Tests: `npx vitest run src/server/connectors`.
