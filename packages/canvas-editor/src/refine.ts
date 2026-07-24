// Pluggable refine surface. The editor is model-agnostic: the host injects a
// RefineProvider (Fable / Sonnet in dev; Gemini 2.5/3, Kimi K3 in Denik).
// The surgical prompt is ported from easybits documentOperations `_refineInternal`.

import type { Node } from './model'

export interface RefineNodeInput {
  /** data-id of the node the edit targets. */
  nodeId: string
  /** Natural-language instruction ("make the title bigger", "dark background"). */
  instruction: string
  /** Current HTML of the target node's subtree (data-id preserved). */
  currentHtml: string
}

export interface GenerateArtboardInput {
  prompt: string
  w: number
  h: number
}

/**
 * Streaming callbacks. The editor is real-time: refine/generate stream partial
 * HTML so the target node re-renders live (the "double stream" — chat tokens in
 * the conversation AND the artifact rendering at the same time, mirroring Teams'
 * existing `kind:"draft"` live preview). Providers that can't stream simply
 * resolve the promise; those that can call `onPartial` as tokens arrive.
 */
export interface RefineStreamHandlers {
  /** Called with the accumulated partial HTML of the node subtree as it streams. */
  onPartial?: (partialHtml: string) => void
  /** Called once when the final HTML is ready (also the promise resolution). */
  onDone?: (finalHtml: string) => void
  /** Abort signal so the host can cancel an in-flight refine. */
  signal?: AbortSignal
}

export interface RefineProvider {
  /**
   * Surgically edit one node. Returns the new HTML for that node's subtree only.
   * If `handlers.onPartial` is provided, stream partial HTML for live preview.
   */
  refineNode(input: RefineNodeInput, handlers?: RefineStreamHandlers): Promise<string>
  /** Generate a fresh frame's node list from a prompt (optional, may stream per section). */
  generateArtboard?(
    input: GenerateArtboardInput,
    handlers?: { onSection?: (node: Node) => void; signal?: AbortSignal },
  ): Promise<Node[]>
}

/**
 * Surgical-edit system prompt. Ported from easybits
 * documentOperations.ts `_refineInternal` (:1114-1121). The invariant: change
 * ONLY the targeted element, keep everything else byte-identical, never rewrite
 * the whole thing, and preserve the data-id.
 */
export const SURGICAL_REFINE_SYSTEM = `You are a surgical HTML+Tailwind editor.
You receive ONE element's HTML (it has a data-id attribute) and an instruction.
RULES:
- Make the SMALLEST possible change that satisfies the instruction.
- Output ONLY the edited element's HTML — the same outer tag, the SAME data-id.
- The result must be 90%+ identical to the input: only what the instruction asks for should differ.
- NEVER add explanations, markdown fences, or extra elements.
- Style exclusively with Tailwind utility classes. Use semantic theme tokens
  (bg-primary, text-foreground, border-border, rounded-[var(--radius)]) when a color/spacing maps to one.
- Preserve nested children and their data-ids unless the instruction explicitly changes them.
Return the raw HTML of the single edited element and nothing else.`

/** Build the user turn for a single-node refine. */
export function buildRefinePrompt(input: RefineNodeInput): string {
  return `Instruction: ${input.instruction}\n\nElement to edit (return the edited element only):\n${input.currentHtml}`
}

/**
 * Image sourcing, injected by the host — mirrors easybits' image work (replace by
 * URL/upload, AI-generate, stock search). All optional; the Image panel only shows
 * the actions the host wired. Each returns a URL to set as the node's src.
 */
export interface ImageProvider {
  /** AI-generate an image from a prompt → URL. */
  generate?(prompt: string): Promise<string>
  /** Search stock/library → candidate URLs. */
  search?(query: string): Promise<string[]>
  /** Upload a file → hosted URL. */
  upload?(file: File): Promise<string>
}

/**
 * Quick agent action on a node (the efecto "robot" button). In Teams this posts
 * the selected node (data-id + html) to the chat agent so the user can ask for an
 * edit in natural language; the agent streams the patch back via RefineProvider.
 */
export interface AgentActionInput {
  nodeId: string
  nodeHtml: string
  /** Optional preset action label ("Redesign", "Make it bigger", …). */
  preset?: string
}
export type AgentAction = (input: AgentActionInput) => void
