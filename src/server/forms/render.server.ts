// Renderiza el HTML del formulario público a partir del schema de campos.
//
// Lo escribe el SERVIDOR, no el agente. El agente decide título, campos y secciones; el
// markup es nuestro. Razones concretas: la visibilidad (`showIf`) tiene que comportarse
// igual en el navegador y en el submit, y el honeypot, el token y la clave de idempotencia
// son invariantes que no pueden depender de que el modelo se acuerde de emitirlos.
//
// CSS PROPIO, sin Tailwind, a propósito: `bakeTailwind` sólo hornea si encuentra el script
// del CDN, y un formulario con clases dinámicas quedaría a medio estilar. Un <style> inline
// de 100 líneas es determinista, abre sin red y no depende del baker.
//
// El HTML se sirve desde `/artefacto/<slug>/raw` dentro de un iframe con CSP
// `sandbox` SIN `allow-same-origin` → origen OPACO. De ahí salen dos reglas duras:
//   · las URLs de submit y upload son ABSOLUTAS (una relativa apuntaría al host del iframe);
//   · el fetch va sin credenciales y el endpoint responde CORS `*` (ver api.form.$token.ts).
import { escapeHtml, formSteps, type FormField } from "../../lib/form-fields";

export type RenderFormArgs = {
  title: string;
  fields: FormField[];
  intro?: string | null;
  thanks?: string | null;
  /** Absoluta: POST del formulario. */
  submitUrl: string;
  /** Absoluta: POST multipart de los campos `file`. */
  uploadUrl: string;
};

export function renderFormHtml(a: RenderFormArgs): string {
  const steps = formSteps(a.fields);
  const multi = steps.length > 1;
  const thanks = a.thanks?.trim() || "¡Gracias! Ya recibimos tus respuestas.";

  const stepsHtml = steps
    .map(
      (s, i) => `<section class="gf-step" data-step="${i}"${i === 0 ? "" : ' hidden=""'}>
      ${s.title ? `<h2 class="gf-sec">${escapeHtml(s.title)}</h2>` : ""}
      ${s.fields.map(fieldHtml).join("\n")}
    </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(a.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="gf-card">
  <header class="gf-head">
    <h1 class="gf-title">${escapeHtml(a.title)}</h1>
    ${a.intro ? `<p class="gf-intro">${escapeHtml(a.intro)}</p>` : ""}
    ${multi ? `<div class="gf-bar"><i id="gf-bar-fill"></i></div><p class="gf-count" id="gf-count"></p>` : ""}
  </header>

  <form id="gf-form" novalidate>
    ${stepsHtml}
    <!-- Trampa para bots: la esconde el CSS, no un atributo hidden (un bot lee el atributo). -->
    <div class="gf-hp"><label>No llenar<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>
    <p class="gf-formerr" id="gf-formerr" hidden=""></p>
    <div class="gf-nav">
      <button type="button" class="gf-btn gf-ghost" id="gf-prev" hidden="">Atrás</button>
      <button type="button" class="gf-btn" id="gf-next"${multi ? "" : ' hidden=""'}>Siguiente</button>
      <button type="submit" class="gf-btn" id="gf-send"${multi ? ' hidden=""' : ""}>Enviar</button>
    </div>
  </form>

  <div class="gf-done" id="gf-done" hidden="">
    <div class="gf-check">✓</div>
    <p>${escapeHtml(thanks)}</p>
  </div>
</main>
<script>
${clientScript(a)}
</script>
</body>
</html>`;
}

// ── Campos ──────────────────────────────────────────────────────────────────────
// Cada control lleva `data-field="<name>"`: el JS lee y escribe SIEMPRE por ese selector,
// nunca por posición en el DOM. Así el formulario sobrevive a cualquier paso que reordene
// o envuelva nodos (por ejemplo el sembrado de ids de los artefactos).

function fieldHtml(f: FormField): string {
  const req = f.required ? `<span class="gf-req" aria-hidden="true">*</span>` : "";
  const showIf = f.showIf
    ? ` data-showif="${escapeHtml(f.showIf.field)}" data-showif-eq="${escapeHtml(f.showIf.equals)}"`
    : "";
  const label = `<label class="gf-label" for="gf-${f.name}">${escapeHtml(f.label)}${req}</label>`;
  const err = `<p class="gf-err" data-err="${f.name}" hidden=""></p>`;

  return `<div class="gf-field" data-for="${f.name}"${showIf}>
      ${f.type === "checkbox" ? "" : label}
      ${controlHtml(f)}
      ${err}
    </div>`;
}

function controlHtml(f: FormField): string {
  const id = `gf-${f.name}`;
  const base = `id="${id}" data-field="${f.name}"`;
  const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : "";

  switch (f.type) {
    case "textarea":
      return `<textarea ${base} class="gf-input" rows="4"${ph}></textarea>`;
    case "select":
      return `<select ${base} class="gf-input">
        <option value="">Selecciona…</option>
        ${(f.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
      </select>`;
    case "checkbox":
      return `<label class="gf-check-row"><input type="checkbox" ${base}> <span>${escapeHtml(
        f.placeholder || f.label
      )}${f.required ? ' <span class="gf-req">*</span>' : ""}</span></label>`;
    case "radio": {
      const opts = f.options?.length ? f.options : ["Sí", "No"];
      return `<div class="gf-opts" ${base} data-kind="radio">
        ${opts
          .map(
            (o, i) =>
              `<label class="gf-opt"><input type="radio" name="${f.name}" value="${escapeHtml(o)}"${
                i === 0 ? ` id="${id}"` : ""
              }> <span>${escapeHtml(o)}</span></label>`
          )
          .join("")}
      </div>`;
    }
    case "matrix": {
      // Una tabla POR matriz y sin anidar nada: es la misma restricción que pide el
      // documento de la ficha (BlockNote no soporta tablas anidadas), así que el
      // formulario y su ficha se ven igual.
      const cols = f.options ?? [];
      return `<div class="gf-matrix-wrap"><table class="gf-matrix" ${base} data-kind="matrix">
        <thead><tr><th></th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>
          ${(f.rows ?? [])
            .map(
              (r, ri) =>
                `<tr data-row="${escapeHtml(r)}"><th scope="row">${escapeHtml(r)}</th>${cols
                  .map(
                    (c) =>
                      `<td><label><input type="radio" name="${f.name}__${ri}" value="${escapeHtml(
                        c
                      )}"><span class="gf-sr">${escapeHtml(c)}</span></label></td>`
                  )
                  .join("")}</tr>`
            )
            .join("")}
        </tbody>
      </table></div>`;
    }
    case "file":
      return `<input type="file" ${base} class="gf-input gf-file"${
        f.accept ? ` accept="${escapeHtml(f.accept)}"` : ""
      }><span class="gf-filenote" data-filenote="${f.name}"></span>`;
    case "number":
      return `<input type="number" step="any" ${base} class="gf-input"${ph}>`;
    case "date":
      return `<input type="date" ${base} class="gf-input">`;
    case "email":
      return `<input type="email" ${base} class="gf-input" autocomplete="email"${ph}>`;
    case "tel":
      return `<input type="tel" ${base} class="gf-input" autocomplete="tel"${ph}>`;
    default:
      return `<input type="text" ${base} class="gf-input"${ph}>`;
  }
}

// ── Cliente ─────────────────────────────────────────────────────────────────────
// El navegador hace SÓLO dos cosas de lógica: visibilidad (`showIf`) y "requerido vacío".
// Las dos son de una línea, así que no pueden divergir del servidor de forma interesante.
// Los formatos (correo, teléfono, matriz completa) los valida el servidor y sus mensajes se
// pintan por campo desde `{ok:false,errors}` — una sola verdad, la de arriba.

function clientScript(a: RenderFormArgs): string {
  // El schema viaja como TEXTO JSON dentro de un literal de JS, no como objeto inlineado:
  // así ningún valor puede escapar a código. Los `<` se van como < porque un
  // `</script>` dentro de una etiqueta cerraría el bloque antes de tiempo.
  const cfgLiteral = JSON.stringify(
    JSON.stringify({ fields: a.fields, submitUrl: a.submitUrl, uploadUrl: a.uploadUrl }).replace(/</g, "\\u003c")
  );

  return `(function(){
var CFG = JSON.parse(${cfgLiteral});
var F = CFG.fields, form = document.getElementById("gf-form");
// Clave de idempotencia: se genera UNA vez al cargar y se reenvía en cada intento, así un
// doble clic o un reintento de red no crean dos respuestas ni dos fichas.
var IDEM = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
var steps = [].slice.call(document.querySelectorAll(".gf-step")), cur = 0;
var files = {};

function el(n){ return form.querySelector('[data-field="' + n + '"]'); }

function readOne(f){
  var n = el(f.name); if (!n) return "";
  if (f.type === "checkbox") return n.checked ? "true" : "";
  if (f.type === "radio") { var c = n.querySelector("input:checked"); return c ? c.value : ""; }
  if (f.type === "matrix") {
    var out = {}, rows = n.querySelectorAll("tbody tr");
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].querySelector("input:checked");
      if (c) out[rows[i].getAttribute("data-row")] = c.value;
    }
    return Object.keys(out).length ? JSON.stringify(out) : "";
  }
  if (f.type === "file") return files[f.name] || "";
  return (n.value || "").trim();
}

function readAll(){ var d = {}; for (var i=0;i<F.length;i++) d[F[i].name] = readOne(F[i]); return d; }

// Misma regla que el servidor: igualdad estricta de texto contra el campo del que depende.
function visible(f, d){ return !f.showIf || d[f.showIf.field] === f.showIf.equals; }

function applyVisibility(){
  var d = readAll();
  for (var i=0;i<F.length;i++){
    var wrap = form.querySelector('.gf-field[data-for="' + F[i].name + '"]');
    if (wrap) wrap.hidden = !visible(F[i], d);
  }
  progress(d);
}

function progress(d){
  var bar = document.getElementById("gf-bar-fill"); if (!bar) return;
  var req = F.filter(function(f){ return f.required && visible(f, d); });
  var done = req.filter(function(f){ return d[f.name]; }).length;
  var pct = req.length ? Math.round(done * 100 / req.length) : 0;
  bar.style.width = pct + "%";
  document.getElementById("gf-count").textContent = "Paso " + (cur+1) + " de " + steps.length;
}

function clearErrors(){
  var es = form.querySelectorAll("[data-err]");
  for (var i=0;i<es.length;i++){ es[i].hidden = true; es[i].textContent = ""; }
  var fe = document.getElementById("gf-formerr"); fe.hidden = true; fe.textContent = "";
}

function showError(name, msg){
  var p = form.querySelector('[data-err="' + name + '"]');
  if (p){ p.textContent = msg; p.hidden = false; }
  else { var fe = document.getElementById("gf-formerr"); fe.textContent = msg; fe.hidden = false; }
}

// Sólo "requerido vacío" en el paso actual: no adelantamos los formatos, para que el
// mensaje que ve la persona sea siempre el del servidor y no dos redacciones distintas.
function stepOk(){
  var d = readAll(), ok = true;
  var names = [].slice.call(steps[cur].querySelectorAll("[data-field]")).map(function(n){ return n.getAttribute("data-field"); });
  clearErrors();
  for (var i=0;i<F.length;i++){
    var f = F[i];
    if (names.indexOf(f.name) < 0) continue;
    if (!visible(f, d)) continue;
    if (f.required && !d[f.name]){ showError(f.name, f.label + " es requerido"); ok = false; }
  }
  return ok;
}

function goto(i){
  cur = Math.max(0, Math.min(steps.length - 1, i));
  for (var k=0;k<steps.length;k++) steps[k].hidden = (k !== cur);
  var last = (cur === steps.length - 1);
  document.getElementById("gf-prev").hidden = (cur === 0);
  document.getElementById("gf-next").hidden = last;
  document.getElementById("gf-send").hidden = !last;
  applyVisibility();
  window.scrollTo(0, 0);
}

form.addEventListener("input", applyVisibility);
form.addEventListener("change", function(ev){
  applyVisibility();
  var t = ev.target;
  if (t && t.type === "file" && t.files && t.files[0]) upload(t);
});

document.getElementById("gf-next").addEventListener("click", function(){ if (stepOk()) goto(cur + 1); });
document.getElementById("gf-prev").addEventListener("click", function(){ goto(cur - 1); });

function upload(input){
  var name = input.getAttribute("data-field");
  var note = form.querySelector('[data-filenote="' + name + '"]');
  var fd = new FormData();
  fd.append("field", name);
  fd.append("file", input.files[0]);
  if (note) note.textContent = "subiendo…";
  fetch(CFG.uploadUrl, { method: "POST", body: fd })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j && j.ok && j.fileId){ files[name] = j.fileId; if (note) note.textContent = j.name || "archivo listo"; }
      else { if (note) note.textContent = ""; showError(name, (j && j.error) || "no se pudo subir el archivo"); }
    })
    .catch(function(){ if (note) note.textContent = ""; showError(name, "no se pudo subir el archivo"); });
}

form.addEventListener("submit", function(ev){
  ev.preventDefault();
  if (!stepOk()) return;
  var send = document.getElementById("gf-send");
  send.disabled = true; send.textContent = "Enviando…";
  var hp = form.querySelector('[name="_hp"]');
  fetch(CFG.submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _idem: IDEM, _hp: hp ? hp.value : "", data: readAll() })
  })
  .then(function(r){ return r.json(); })
  .then(function(j){
    send.disabled = false; send.textContent = "Enviar";
    if (j && j.ok){
      form.hidden = true;
      var h = document.querySelector(".gf-head"); if (h) h.hidden = true;
      document.getElementById("gf-done").hidden = false;
      if (j.deliveryUrl) setTimeout(function(){ location.href = j.deliveryUrl; }, 1200);
      return;
    }
    clearErrors();
    var errs = (j && j.errors) || {};
    var keys = Object.keys(errs), first = null;
    for (var i=0;i<keys.length;i++){ showError(keys[i], errs[keys[i]]); if (!first) first = keys[i]; }
    if (!keys.length) showError("_form", "No se pudo enviar. Inténtalo de nuevo.");
    // El error puede estar en un paso anterior: llevar a la persona ahí, no dejarla
    // mirando un botón que no hace nada.
    if (first){
      for (var s=0;s<steps.length;s++){
        if (steps[s].querySelector('[data-field="' + first + '"]')){ goto(s); showError(first, errs[first]); break; }
      }
    }
  })
  .catch(function(){
    send.disabled = false; send.textContent = "Enviar";
    showError("_form", "Sin conexión. Inténtalo de nuevo.");
  });
});

goto(0);
})();`;
}

const CSS = `
:root{--accent:#9870ED;--accent-ink:#7c5ce0;--tint:#f4edfd;--ink:#1c1a22;--muted:#6b6575;--line:#e5e1ef;--req:#c2410c;--ok:#15803d;--paper:#faf9fc}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 64px;background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.gf-card{max-width:640px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(28,26,34,.04),0 8px 24px rgba(28,26,34,.05);padding:28px 24px}
.gf-head{margin-bottom:24px}
.gf-title{margin:0;font-size:24px;line-height:1.25;font-weight:650;font-family:"Iowan Old Style",Georgia,serif}
.gf-intro{margin:8px 0 0;color:var(--muted);font-size:15px}
.gf-bar{height:4px;background:var(--tint);border-radius:99px;margin-top:18px;overflow:hidden}
.gf-bar>i{display:block;height:100%;width:0;background:var(--accent);transition:width .25s ease}
.gf-count{margin:6px 0 0;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.gf-sec{margin:0 0 18px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent-ink)}
.gf-field{margin-bottom:18px}
.gf-field[hidden]{display:none}
.gf-label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
.gf-req{color:var(--req);margin-left:2px}
.gf-input{width:100%;padding:10px 12px;font:inherit;color:inherit;background:#fff;border:1px solid var(--line);border-radius:8px;outline:none}
.gf-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--tint)}
textarea.gf-input{resize:vertical;min-height:96px}
.gf-opts{display:flex;flex-direction:column;gap:8px}
.gf-opt,.gf-check-row{display:flex;align-items:flex-start;gap:8px;font-size:15px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.gf-opt:hover,.gf-check-row:hover{background:var(--tint)}
.gf-matrix-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
.gf-matrix{width:100%;border-collapse:collapse;font-size:14px}
.gf-matrix th,.gf-matrix td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:center}
.gf-matrix thead th{background:var(--tint);font-size:12px;font-weight:700;color:var(--accent-ink)}
.gf-matrix tbody th{text-align:left;font-weight:500}
.gf-matrix tbody tr:last-child th,.gf-matrix tbody tr:last-child td{border-bottom:0}
.gf-matrix td label{display:block;cursor:pointer}
.gf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.gf-filenote{display:block;margin-top:6px;font-size:13px;color:var(--ok)}
.gf-err{margin:6px 0 0;font-size:13px;color:var(--req)}
.gf-formerr{margin:0 0 12px;font-size:14px;color:var(--req)}
.gf-hp{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden}
.gf-nav{display:flex;gap:10px;justify-content:flex-end;margin-top:24px;padding-top:18px;border-top:1px solid var(--line)}
.gf-btn{font:inherit;font-weight:600;font-size:15px;padding:10px 20px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.gf-btn:hover{filter:brightness(1.06)}
.gf-btn:disabled{opacity:.6;cursor:default}
.gf-ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.gf-done{text-align:center;padding:32px 8px}
.gf-check{width:56px;height:56px;margin:0 auto 16px;border-radius:99px;background:var(--tint);color:var(--ok);font-size:28px;line-height:56px;font-weight:700}
@media (max-width:520px){.gf-card{padding:20px 16px}.gf-title{font-size:21px}}
`;
