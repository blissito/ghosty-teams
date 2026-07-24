# @ghosty/canvas-editor

DOM-native, **WASM-free** visual editor for HTML+Tailwind artifacts. The canvas is
real DOM (React), the way [efecto.app](https://efecto.app) and
[tldraw](https://tldraw.dev) do it — pan/zoom is a single CSS `transform` on a
camera container, so the browser's GPU compositor does the work and every node
stays a live, inspectable, Tailwind-styled element.

This is the **first of a family of reusable "specialized artifacts"** for Ghosty
Teams / Studio (and, later, Denik). It is a standalone package with **zero host
dependencies** (React is a peer). Teams consumes it via the `@ghosty/canvas-editor`
tsconfig path; Denik will consume it to replace its GrapesJS landing editor.

---

## The Specialized-Artifact Pattern (read this before adding another one)

Every reusable artifact follows the same contract so the host (Teams/Denik) can
mount, persist, serve and let an agent edit it uniformly:

1. **Canonical model, not HTML-as-blob.** The artifact has a typed data model
   (here `Doc = { artboards, theme }`, each node carrying a stable `data-id`).
   The model — never a raw string — is the source of truth in the editor.

2. **Lossless `toHtml` / `fromHtml` round-trip.** `docToHtml(doc)` produces the
   HTML we persist in `gc_artifacts.md` and serve at `artefacto.ghosty.studio`;
   `htmlToDoc(html)` parses it back with every `data-id` preserved. Round-trip is
   idempotent (unit-tested). This means **zero schema changes** in the host: the
   artifact still lives as an HTML string in the existing storage.

3. **`data-id` addressing → targeted edits.** Because every node has a stable id,
   the agent edits ONE node (`replaceNodeSubtree(id, …)`) instead of re-emitting
   the whole artifact. This closes `todo_targeted_html_edits` (parity with the
   EasyBits patch primitives `setSectionHtmlBySelector` / `replaceHtmlInPage`).

4. **Pluggable `RefineProvider`.** The editor is model-agnostic. The host injects
   the LLM (`refineNode` / `generateArtboard`): Fable 5 & Sonnet in dev; Gemini
   2.5/3, Kimi K3 in Denik. The surgical prompt (`SURGICAL_REFINE_SYSTEM`) is
   ported from easybits and forces "change only the targeted element".

5. **Host-independent chrome.** The editor's own UI (toolbar, panels, layers) uses
   inline styles — it must NOT depend on the host's Tailwind. Only the *artifact
   content* (the nodes) uses Tailwind classes, which the host provides.

6. **Edit ⇄ Preview.** A ▶ toggle drops the camera/chrome and renders
   `docToHtml(doc)` as plain full-width HTML — exactly what publishes.

7. **Agent-usable, real-time.** These artifacts are surfaces the *agent* operates,
   not just the human. The agent edits by `data-id` through the RefineProvider,
   and edits stream **in real time**.

### The "double stream"

Teams already streams two things at once and this editor plugs into that:

- **Stream A — chat tokens:** the agent's reply text streaming into the conversation.
- **Stream B — artifact render:** the artifact updating live while the agent works.
  Today Teams does this with `kind:"draft"` (iframe `srcDoc` refreshed as the
  `eb-artifact` fence fills — `ArtifactPanel.tsx`, `chat.ts`).

For targeted edits we keep both streams but scope Stream B to **one node**:
`RefineProvider.refineNode(input, { onPartial })` emits partial HTML for the target
subtree, and the editor calls `store.replaceNodeSubtree(id, htmlToDoc(partial)…)`
on each tick so only that node re-renders live — while the chat keeps streaming.
No full-artifact re-render, no flicker on the rest of the canvas.

### To add another specialized artifact (e.g. a slide deck, a form, a chart)

- New package `packages/<name>-artifact/` mirroring this layout:
  `model.ts` (typed model + presets), `serialize.ts` (`toHtml`/`fromHtml` +
  round-trip test), `store.ts` (tiny `useSyncExternalStore` store, immutable
  actions, undo/redo), `refine.ts` (RefineProvider + surgical prompt),
  the React editor components, `index.ts` (public exports).
- Persist through the SAME host surface: `gc_artifacts` (a new row per version,
  same `url`/documentId) via `updateArtifactHtmlFn`.
- Mount in `ArtifactPanel.tsx` keyed by `kind` (`"artifact"` → this canvas).
- Keep chrome inline-styled, content in Tailwind, and the model round-trippable.

---

## Public API

```ts
import {
  CanvasEditor,          // <CanvasEditor doc onChange refineProvider />
  EditorStore, useEditor,
  makeEmptyDoc, htmlToDoc, docToHtml,
  ARTBOARD_PRESETS,
  type Doc, type Node, type Artboard, type Theme, type RefineProvider,
} from '@ghosty/canvas-editor'
```

### Model
- `Doc { id, artboards: Artboard[], theme: Theme }`
- `Artboard { id, name, x, y, w, h, cls?, nodes: Node[] }` — frames of arbitrary
  dimensions; `ARTBOARD_PRESETS` = Desktop/Mobile/IG/Story/Card/Poster/A4/…
- `Node { id (data-id), tag, cls (Tailwind = source of truth), text?, src?, href?, children }`
- `Theme { name, mode, tokens (colors), fonts (heading/body/mono — a separate axis), radius }`

### Camera
Single `transform: translate(x,y) scale(z)` on the world container. Zoom 0.01–64,
zoom-toward-cursor (`store.zoomAt`), center-on-node (`store.centerOnRect`) driven
by clicking a layer. Viewport **culling** (`display:none` off-screen) from day 1 —
the DOM's practical ceiling is ~1–3k *visible* nodes, so we cull.

## Features (F1 ✅)
- Infinite DOM canvas: transform-camera pan/zoom (zoom-to-cursor), artboard culling, **camera persisted per doc** (refresh keeps zoom+pan; fit only on first open).
- Multi-artboard with dimension **presets** (Desktop/Mobile/IG/Story/Card/Poster/A4).
- **Selection**: click, multi-select (Cmd/Shift-click) with union bounding box, layers-tree click centers camera, x-ray tag reveal.
- **Resize handles** (real px via the arbitrary-value mini-JIT), **Alt-drag clone**, autolayout **drag-reorder with snap**.
- **Group → autolayout frame** (⌘G / button), **ungroup** (⌘⇧G / button), **duplicate** (⌘D), delete, **undo/redo**.
- **Inspector** (efecto-style): Tag, Typography (Size/Leading/Weight/Tracking/Align), Layout display + align/justify/gap, Size&Spacing (Hug/Fixed/Fill, padding/margin/overflow), Colors, Radius, class **chips + Tailwind autocomplete** with a raw code toggle, tooltips on icon controls.
- **Theme / Brand**: real light/dark palettes, **font selects** (heading/body), radius presets, palette swatches.
- **Image panel** (easybits-style): src / preview / **AI-generate** / **search** / upload via injected `ImageProvider`.
- **Targeted refine** by `data-id` with streaming (double-stream); pluggable `RefineProvider`. **Robot quick-action** button hands the node to the chat agent (`onAgentAction`); selection is published to the host (`onSelectionChange`).
- **Edit ⇄ Preview** with device sizes (Full/Desktop/Tablet/Mobile); **Export Code** modal (HTML+Tailwind) + copy; **dirty/Save** indicator; focus mode (hide panels).
- 15 unit tests (round-trip, moveNode, group/ungroup/duplicate, selection, undo/dirty). Demo route: `/canvas-demo`.

Also shipped: marquee-select, arrow-key reorder, per-layer lock/hide, effects (shadow/opacity).

## Pending / roadmap

**Integration (the whole point — do these to ship it for real):**
- **F2 — mount in Teams**: render `<CanvasEditor>` in `ArtifactPanel.tsx` (rama `kind:"artifact"`), add `updateArtifactHtmlFn` in `src/server/artifacts.ts` persisting to `gc_artifacts` (new row, same `url`), wire the `artifacts.tsx` studio. The demo's localStorage persistence is a stand-in — **real save is not wired yet**.
- **F3 — agent refine**: SSE endpoint running the pluggable model; wire `RefineProvider` + `onAgentAction` (robot button) to the Teams chat agent so edits stream back into the canvas by `data-id`.
- **F4 — Denik/agenda**: consume the package to replace GrapesJS; adapter `Section3[] ⇄ Doc`; inject the provider per host (Gemini 2.5/3, Kimi K3 — provider switch).

**High-value editor features not yet built (gap audit vs Figma/efecto/Framer/Webflow):**
- **Reusable components / instances** (symbols) — needs a `components` registry in the model + instance refs + serialization (embed a JSON blob in the exported HTML). Highest product ROI; a dedicated piece.
- **Responsive per-breakpoint overrides** (Desktop↔Mobile sync) — needs per-artboard override model.
- **Hover/focus state editor** (edit `hover:`/`focus:` variant classes visually), gradients UI (from/to color pickers).
- **Align/distribute & smart alignment guides** — NOTE: our model is **flow/flex** (responsive HTML), not free-absolute like Figma; alignment is expressed via the container's Layout controls (align/justify), so Figma-style free align/distribute maps differently. Revisit if we add absolute-positioned nodes.

**Out of scope for the artifact editor:** Framer-style interactions/animation, CMS/data-binding, live multiplayer, full Brand System tab (Mood/Identity/Imagery/AI-guidelines + brand presets), efecto **FX** (poster effects/shaders).

See the full plan: `~/.claude/plans/el-plan-porque-te-misty-muffin.md`.
