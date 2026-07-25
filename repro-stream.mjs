import http from 'node:http'
import { makeArtifactHtmlTransform } from './src/lib/artifact-stream-doc.ts'

const TW = process.env.TW || 'none'
const twTag = TW === 'sync' ? '<script src="https://cdn.tailwindcss.com"></script>' : TW === 'async' ? '<script async src="https://cdn.tailwindcss.com"></script>' : ''
const ART = `<!doctype html><html><head>${twTag}
<style>:root{--color-background:#0b1020;--color-foreground:#e8e8f0;--color-primary:#8b5cf6}</style>
</head><body class="bg-[var(--color-background)] text-[var(--color-foreground)] p-10">
${Array.from({length:12},(_,i)=>`<section class="mb-6 rounded-2xl bg-[var(--color-primary)] p-8 text-3xl font-bold">Bloque ${i+1} del bento</section>`).join('\n')}
</body></html>`

http.createServer(async (req, res) => {
  if (req.url.startsWith('/host')) {
    res.writeHead(200, {'content-type':'text/html'})
    return res.end(`<body style="margin:0;background:#111"><iframe id="f" src="/stream" sandbox="allow-scripts allow-forms allow-popups" style="position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent"></iframe>`)
  }
  if (req.url.startsWith('/stream')) {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store, no-transform'})
    const t = makeArtifactHtmlTransform()
    res.write(t('') + `<script>const t0=Date.now();setInterval(()=>{console.log('INSIDE t='+((Date.now()-t0)/1000).toFixed(1)+'s hijos='+document.body.children.length+' altura='+document.body.scrollHeight)},700)</script>`)
    let i = 0
    const step = 45
    const iv = setInterval(() => {
      if (i >= ART.length) { clearInterval(iv); return res.end() }
      res.write(t(ART.slice(i, i + step)))
      i += step
    }, 400)
    return
  }
  res.writeHead(404); res.end()
}).listen(4599, () => console.log('repro on 4599'))
