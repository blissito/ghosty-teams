# Para quien esté trabajando la co-edición — 2026-07-31

## 1. Tus cambios YA ESTÁN EN PRODUCCIÓN, pero NO commiteados

A las ~10:00 hice un hot-deploy de Teams (`deploy_ghosty_teams.sh`, `unit=active`) para
sacar cuatro arreglos del chat. El build se lleva el **working tree entero**, así que
salieron a prod contigo estos archivos, que siguen sin commitear:

- `src/components/ArtifactShareDialog.tsx`
- `src/server/artifacts.ts`
- `src/server/collab-state.server.ts`
- `src/routes/api.collab.$docId.session-end.ts`

O sea: lo que corre en `business.teams.ghosty.studio` incluye tu trabajo en curso.
Commitéalo cuando esté listo — hasta entonces, prod y `main` no coinciden.

Además, tu commit `ad6cda4` ("feat(compartir): elegir gente del workspace al invitar")
se llevó por delante parte de MIS cambios que estaban en el working tree al mismo tiempo:
`src/routes/__root.tsx`, `src/utils/reload-guard.ts` y trozos de `router.tsx` y
`c.$slug.tsx`. No hay nada que arreglar —el código es correcto y está en main— pero el
mensaje de ese commit no describe esa parte. Contexto real, por si te extraña:

## 2. Qué son esos archivos que aparecieron en tu commit

`src/utils/reload-guard.ts` + la exención de `/assets/` en `__root.tsx` arreglan esto:
una pestaña abierta ANTES de un deploy pide chunks del build anterior; el deploy reemplaza
`.output` entero, el hash muere, y `/assets/*` **pasaba por el guard de sesión** → `307 →
/login`, o sea HTML donde el navegador esperaba JS. El síntoma no se parecía en nada a la
causa: un hilo entero se quedaba en "Algo en esta vista se atoró" para siempre.

Ahora `/assets/`, `/_build/`, `/sw.js`, `/favicon.ico` y `/manifest.webmanifest` salen
antes de **los dos** guards (el de tenant y el de sesión) → 404 de Nitro, y el listener de
`vite:preloadError` recarga sola la página. Guard anti-loop compartido (`gc-resume`, 3
intentos en 30s) — no metas un segundo contador si necesitas recargar desde otro sitio,
usa `puedeAutoRecargar()`.

⚠️ **Esto te toca de cerca**: el editor colaborativo carga varios chunks perezosos, así
que era de los caminos más expuestos. Si ves un fallo de import dinámico, ya no lo tapes
con un boundary: déjalo llegar al guard.

## 3. Lo demás que cambió hoy, por si tocas los mismos archivos

- `src/lib/ebdoc.ts` — `scanFences`/`cutFences` nuevos: TODOS los fences, no sólo el
  primero. `extractAllEbAudio` / `extractAllEbFile`. Si añades un tipo de bloque, úsalos.
- `src/db.server.ts` `searchRoomMessages` — perdió el `AND m.parent_id IS NULL` y acepta
  `{ threadRootId }`.
- `src/server/ses.server.ts` — soporta adjuntos (`multipart/mixed`), y hay tool nativa
  `email_send` (`src/server/connectors/email-send.server.ts`).
- Tabla nueva `gt_email_log` en `schema.server.ts`.

## 4. Pendiente que NO es tuyo pero comparte terreno

**Read Aloud fase 2** (pedido por el abogado en el demo del 30-jul). Es diseño, no código
todavía: dónde se cachea el audio por bloque y cómo se invalida al **editar** un bloque ya
sintetizado. Eso último cae justo en la co-edición — si cambias cómo se identifican o
versionan los bloques, avísalo. La clave natural del caché es
`(blockUuid, hash del texto, voz)`. Detalle completo en el TODO de
`~/ghosty-studio/CLAUDE.md`.
