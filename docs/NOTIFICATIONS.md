# Notificaciones y llamadas — cómo llega un aviso

Referencia: Slack/Zulip. Estado tras la auditoría del **2026-07-27**.

## Los dos caminos (no deben pisarse)

Un aviso llega por UNO de dos caminos, según si el usuario tiene una pestaña
conectada al bus SSE:

| Situación | Quién avisa | Qué se ve |
|---|---|---|
| Pestaña abierta y **mirando** el scope | cliente (`c.$slug.tsx`) | sonido + toast in-app; se marca leído, sin badge |
| Pestaña abierta pero **oculta** u otro scope | cliente | sonido + toast + notificación del SO vía SW; badge |
| **Sin pestaña** (app cerrada) | server (Web Push) | notificación del SO + badge del ícono |

El gating vive en UN solo lugar: `deliverWebPush` (`src/server/notify.server.ts`)
filtra por `isOnline(ns, sub)` — mismo criterio que el email. Sin ese filtro, quien
está online recibe el aviso dos veces.

**Excepción: las llamadas se saltan el filtro.** Una pestaña en segundo plano puede
tener el audio silenciado o throttleado, y el timbre pasa desapercibido.

## Reglas duras

- **Nunca `new Notification(...)`.** Ese constructor **no existe en Android/Chrome-PWA**
  (lanza `TypeError`) y el aviso se pierde en silencio. Todo pasa por
  `registration.showNotification` — `src/utils/system-notification.ts` desde la
  página, `public/sw.js` desde el push.
- **Tag único por notificación**, salvo que se quiera reemplazar/retirar a propósito.
  Con un tag compartido, dos mensajes seguidos se sustituyen entre sí y parece que
  "no llegan".
- **Marcar leído en TRES momentos**, no dos: al cambiar de scope, al llegar un mensaje
  con la pestaña visible, y **al volver a la pestaña** (`visibilitychange`/`focus`).
  Faltaba el tercero y los mensajes llegados con la pestaña oculta quedaban no-leídos
  para siempre — el scope no cambia, así que ningún effect re-dispara. Era la causa de
  las burbujas acumuladas en un DM 1:1 activo.

## Badge del ícono (PWA)

`navigator.setAppBadge(total)` en dos lados, porque cubren estados distintos:

- **Página** (`c.$slug.tsx`): effect sobre el total de `unreadRooms + unreadDms`.
- **Service Worker** (`sw.js`, handler `push`): con la app cerrada la página no corre.
  El payload trae `badge`, que el server calcula **por destinatario**
  (`listPushSubsForUsers` devuelve `user_sub` justo para esto).

iOS exige la app instalada desde "Añadir a inicio"; sin permiso de notificaciones
concedido no hay badge en ningún navegador.

## Llamadas (quick calls)

`quickcall:started` viaja por el bus SSE **y** por Web Push:

- El evento SSE sólo lo ve quien tiene ese canal a la vista → en un room público,
  quien estuviera en otra ventana no se enteraba.
- El push (`kind: "call"`) va a la audiencia completa: room público = workspace,
  privado = miembros, DM = miembros. Menos el host, menos los silenciados.
- `TTL 45s` + `urgency: high`: una llamada caduca; no debe aparecer "te llaman" 20
  minutos después.
- `tag: call:<callId>` es **load-bearing**: al colgar, `endCall` manda un push
  `{close:true}` con ese mismo tag y el SW **retira** la notificación. Sin eso queda
  un "te llaman" muerto en pantalla (usan `requireInteraction`, no se auto-ocultan)
  que al tocarlo no lleva a ninguna llamada.

## Pendientes

- **`gc_notify_prefs`**: no hay opt-out por usuario ni "todos los mensajes vs sólo
  menciones" por canal (Slack lo tiene por canal). Bloquea el correo resumen semanal
  — un correo periódico sin unsubscribe no se manda.
- **Deep link del push de DM**: hoy abre `/` (los DMs son estado-cliente dentro de
  `/c/$slug`).
- El SW no agrupa: N mensajes de un mismo hilo = N banners.

## Mapa de archivos

- `src/server/notify.server.ts` — capa agnóstica: fan-out a Web Push + email (SES).
- `src/push.server.ts` — VAPID, `sendPush`, shape del payload.
- `public/sw.js` — `push` / `notificationclick`; badge y cierre remoto.
- `src/utils/system-notification.ts` — aviso del SO disparado por la página.
- `src/utils/push-subscribe.ts` — permiso + suscripción. `reconcilePushSubscription()`
  corre al registrar el SW (`pwa-install.ts`) y re-suscribe solo si la sub del browser
  quedó firmada con un VAPID ya rotado: sin eso el panel dice "activado" y no llega nada.

## Rotar VAPID

Cambiar `VAPID_PUBLIC_KEY` (`src/push.server.ts`) **invalida todas las subs**. Receta:
`npx web-push generate-vapid-keys` → pública a la constante, privada a
`/app/secrets.env` de la caja (con `read -s`, nunca por argv) → restart → borrar las
filas de `gc_push_subs` (quedan huérfanas). Los clientes se reconcilian solos al cargar.
⚠️ Guarda la privada: la del par 2026-07-22 se perdió al migrar la caja y por eso hubo
que rotar el 2026-07-27. Ver el checklist de secretos en `DEPLOY.md`.
- `src/server/reads.ts` + `db.markRead/unreadBy*` — no-leídos.
- `src/server/quick-calls.ts` — llamadas.
