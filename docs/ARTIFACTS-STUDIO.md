# Estudio de Artefactos (GTeams) — WIP

**Estado:** scaffold puesto (2026-07-08). Mañana se construye. NO shippeado como feature.

## Qué es

Una sección propia en GTeams — **"Artefactos"**, en el nav **debajo de "Formularios"** — para
**crear** artefactos (documentos, hojas/CSV, office, PDFs, sitios) y **guardarlos en el propio
team**, listados ahí. Hoy los artefactos nacen SOLO como subproducto de una respuesta del agente
(un `eb-doc` en el chat → card en el `ArtifactPanel`). Esto les da una superficie de primera clase:
crear a propósito, persistir, re-abrir, versionar.

## Qué ya existe (scaffold)

- **Nav:** `src/routes/c.$slug.tsx` — `<Link to="/artifacts">` con icono `Layers`, justo debajo del
  link de Formularios.
- **Ruta stub:** `src/routes/artifacts.tsx` — página placeholder (WIP), botón "Nuevo artefacto"
  deshabilitado. Sin persistencia todavía.

## Pendientes (en orden)

1. **Persistencia.** Tabla `gc_artifacts` — revisar si REUTILIZAR la que ya usa el doc-artefacto
   vivo (`gc_artifacts.md`, ver `db.server.ts` / `getDocMarkdown` / `setThreadArtifact`) o crear una
   dedicada con `kind` (doc/sheet/office/pdf/site), `title`, `body`/`md`/`csv`, `updated_at`,
   `channel_id?` (o team-scoped global). Añadir `ensureSchema()` aditivo (patrón `schema.server.ts`).
2. **Server fns CRUD** (`src/server/artifacts.ts`, patrón `server/forms.ts`):
   - `listTeamArtifactsFn` — lista los artefactos del team (poblar la página).
   - `createArtifactFn` — crea uno: mint editor colab (`mintCollabEmbed`) o doc EasyBits vía platform
     key; guarda ref local; devuelve id para abrir en el panel.
   - `deleteArtifactFn` / `renameArtifactFn`.
3. **UI lista** — card por artefacto (kind + título + updated) → click abre en `ArtifactPanel`
   (reusar `ArtifactView`: kinds `doc`/`sheet`/`office`/`pdf` ya existen en el panel).
4. **Crear "en frío"** — hoy el `ArtifactPanel` abre draft desde un turno del agente. Falta un
   camino de creación directa (elegir kind → editor vacío → guardar).

## Relación con el viewer xlsx/csv (ya hecho hoy)

El `ArtifactPanel` ya renderiza `kind:"sheet"` (CSV → `CsvTable`) y `kind:"office"` (docx via mammoth
/ visor Office). El estudio reusa esos renders; solo falta el CRUD + la superficie de creación.
