import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { CanvasEditor, makeEmptyDoc, type Doc, type RefineProvider, type ImageProvider, type AgentAction } from '@ghosty/canvas-editor'
import { BLOCKS } from '@ghosty/canvas-editor'

// Standalone visual smoke for @ghosty/canvas-editor (F1 verification).
// Open at /canvas-demo with `pnpm dev`. No server wiring — refine is mocked.
export const Route = createFileRoute('/canvas-demo')({
  component: CanvasDemo,
})

const DOC_KEY = 'ce-demo-doc-v2'

function seedDoc(): Doc {
  // In the demo, persist the doc to localStorage so refreshes keep edits
  // (real persistence to gc_artifacts is F2). Fall back to a seeded landing.
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(DOC_KEY)
    if (raw) return JSON.parse(raw) as Doc
  } catch {
    /* ignore */
  }
  const doc = makeEmptyDoc('doc_demo')
  const hero = BLOCKS.find((b) => b.key === 'hero')!.make()
  const features = BLOCKS.find((b) => b.key === 'features')!.make()
  doc.artboards[0].nodes = [hero, features]
  // a second frame (mobile) to show multi-artboard + presets
  doc.artboards.push({
    id: 'ab_mobile',
    name: 'Mobile',
    x: 1520,
    y: 0,
    w: 375,
    h: 812,
    cls: 'bg-white',
    nodes: [BLOCKS.find((b) => b.key === 'cta')!.make()],
  })
  return doc
}

// Mock provider: streams the current HTML back with a tweak, to demo live refine.
const mockRefine: RefineProvider = {
  async refineNode({ currentHtml, instruction }, handlers) {
    const bumped = currentHtml.replace(/class="([^"]*)"/, (_m, c) => `class="${c} ring-2 ring-fuchsia-500"`)
    const steps = 4
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 120))
      handlers?.onPartial?.(i < steps ? currentHtml : bumped)
    }
    void instruction
    return bumped
  },
}

const mockImages: ImageProvider = {
  async generate() {
    await new Promise((r) => setTimeout(r, 400))
    return 'https://placehold.co/600x400/7c3aed/fff?text=AI'
  },
  async search() {
    await new Promise((r) => setTimeout(r, 300))
    return [1, 2, 3, 4, 5, 6].map((i) => `https://placehold.co/300x200?text=${i}`)
  },
  async upload(file) {
    return URL.createObjectURL(file)
  },
}

function CanvasDemo() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const doc = useMemo(seedDoc, [])
  const onAgentAction: AgentAction = (input) => {
    // In Teams this posts to the chat agent; here we just log.
    console.log('agent action on', input.nodeId, input.nodeHtml.slice(0, 60))
    alert(`El agente editaría el nodo ${input.nodeId} (en Teams se lo pides por chat).`)
  }
  if (!mounted) return <div style={{ height: '100vh', background: '#0f0f12' }} />
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <CanvasEditor
        doc={doc}
        refineProvider={mockRefine}
        imageProvider={mockImages}
        onAgentAction={onAgentAction}
        onSelectionChange={(id) => console.log('selection', id)}
        onChange={(d) => {
          try {
            localStorage.setItem(DOC_KEY, JSON.stringify(d))
          } catch {
            /* ignore */
          }
        }}
        onSave={async (d) => {
          localStorage.setItem(DOC_KEY, JSON.stringify(d))
        }}
      />
    </div>
  )
}
