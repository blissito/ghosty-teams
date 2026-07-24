// @ghosty/canvas-editor — public API

export { CanvasEditor, type CanvasEditorProps } from './CanvasEditor'
export { EditorStore, useEditor, clampZoom, MIN_Z, MAX_Z, type EditorState, type Camera } from './store'
export {
  type Doc,
  type Artboard,
  type Node,
  type NodeId,
  type Theme,
  type ThemeFonts,
  type ArtboardPreset,
  ARTBOARD_PRESETS,
  DEFAULT_THEME,
  makeEmptyDoc,
  makeArtboard,
  genId,
  findNode,
  findArtboardOf,
  walk,
} from './model'
export { docToHtml, htmlToDoc, htmlToNode, nodeSubtreeToHtml, themeToCss, semanticUtilityCss, arbitraryUtilityCss, type ParseOpts } from './serialize'
export {
  type RefineProvider,
  type RefineNodeInput,
  type RefineStreamHandlers,
  type GenerateArtboardInput,
  type ImageProvider,
  type AgentAction,
  type AgentActionInput,
  SURGICAL_REFINE_SYSTEM,
  buildRefinePrompt,
} from './refine'
export { BLOCKS, BLOCKS_BY_CATEGORY, type BlockDef } from './blocks'
export * from './tailwindClasses'
