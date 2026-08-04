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
import { escapeHtml, formSteps, itemKey, type FormField } from "../../lib/form-fields";
import { fill, formStrings, toFormLocale, type FormLocale, type FormStrings } from "../../lib/form-strings";

export type RenderFormArgs = {
  title: string;
  fields: FormField[];
  intro?: string | null;
  thanks?: string | null;
  /** Absoluta: POST del formulario. */
  submitUrl: string;
  /** Absoluta: POST multipart de los campos `file`. */
  uploadUrl: string;
  /** Idioma del formulario. Se hornea aquí: al abrirlo no hay cookie ni sesión que mirar. */
  locale?: FormLocale;
};

export function renderFormHtml(a: RenderFormArgs): string {
  const locale = toFormLocale(a.locale);
  const s = formStrings(locale);
  const steps = formSteps(a.fields);
  const multi = steps.length > 1;
  const thanks = a.thanks?.trim() || s.thanksDefault;

  const stepsHtml = steps
    .map(
      (st, i) => `<section class="gf-step" data-step="${i}"${i === 0 ? "" : ' hidden=""'}>
      ${st.title ? `<h2 class="gf-sec">${escapeHtml(st.title)}</h2>` : ""}
      ${st.fields.map((f) => fieldHtml(f, s)).join("\n")}
    </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="${locale}">
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
    <div class="gf-hp"><label>${escapeHtml(s.honeypot)}<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>
    <p class="gf-formerr" id="gf-formerr" hidden=""></p>
    <div class="gf-nav">
      <button type="button" class="gf-btn gf-ghost" id="gf-prev" hidden="">${escapeHtml(s.back)}</button>
      <button type="button" class="gf-btn" id="gf-next"${multi ? "" : ' hidden=""'}>${escapeHtml(s.next)}</button>
      <button type="submit" class="gf-btn" id="gf-send"${multi ? ' hidden=""' : ""}>${escapeHtml(s.send)}</button>
    </div>
  </form>

  <div class="gf-done" id="gf-done" hidden="">
    <div class="gf-check">✓</div>
    <p>${escapeHtml(thanks)}</p>
  </div>
</main>
<script>
${clientScript(a, s)}
</script>
</body>
</html>`;
}

// ── Campos ──────────────────────────────────────────────────────────────────────
// Cada control lleva `data-field="<name>"`: el JS lee y escribe SIEMPRE por ese selector,
// nunca por posición en el DOM. Así el formulario sobrevive a cualquier paso que reordene
// o envuelva nodos (por ejemplo el sembrado de ids de los artefactos).

function fieldHtml(f: FormField, s: FormStrings, key = f.name): string {
  if (f.type === "group") return groupHtml(f, s);
  const req = f.required ? `<span class="gf-req" aria-hidden="true">*</span>` : "";
  // `data-showif` guarda el nombre PELADO del campo del que depende, no su clave con
  // índice: dentro de una lista la dependencia es siempre un hermano del mismo elemento,
  // así que el índice lo pone quien evalúa, no el markup. Eso es lo que permite clonar un
  // bloque sin reescribir esta pareja de atributos.
  const showIf = f.showIf
    ? ` data-showif="${escapeHtml(f.showIf.field)}" data-showif-eq="${escapeHtml(f.showIf.equals)}"`
    : "";
  const id = `gf-${cssKey(key)}`;
  const label = `<label class="gf-label" for="${id}">${escapeHtml(f.label)}${req}</label>`;
  const err = `<p class="gf-err" data-err="${escapeHtml(key)}" hidden=""></p>`;

  return `<div class="gf-field" data-for="${escapeHtml(key)}"${showIf}>
      ${f.type === "checkbox" ? "" : label}
      ${controlHtml(f, s, key)}
      ${err}
    </div>`;
}

/** `herederos.0.nombre` no es un id de HTML válido de leer; los puntos se van a guiones. */
function cssKey(key: string): string {
  return key.replace(/\./g, "-");
}

/**
 * Una lista repetible: los bloques ya puestos, una PLANTILLA inerte con `__i__` de índice, y
 * el botón de agregar. El clonado y el reordenado los hace el cliente (`reindex`).
 *
 * El `<template>` es inerte por especificación: su contenido no se parsea como parte del
 * documento, así que sus `data-field` con `__i__` NUNCA los ve `readAll()` ni el validador.
 */
function groupHtml(f: FormField, s: FormStrings): string {
  const req = f.required ? `<span class="gf-req" aria-hidden="true">*</span>` : "";
  const showIf = f.showIf
    ? ` data-showif="${escapeHtml(f.showIf.field)}" data-showif-eq="${escapeHtml(f.showIf.equals)}"`
    : "";
  const item = f.itemLabel?.trim() || s.itemDefault;
  const subs = f.fields ?? [];
  const tpl = itemBlockHtml(f, subs, s);

  return `<div class="gf-field gf-group" data-for="${f.name}" data-group="${f.name}" data-item="${escapeHtml(
    item
  )}" data-min="${f.required ? Math.max(1, f.min ?? 1) : (f.min ?? 0)}" data-max="${f.max ?? 10}"${showIf}>
      <label class="gf-label">${escapeHtml(f.label)}${req}</label>
      <div class="gf-items" data-items="${f.name}"></div>
      <template data-tpl="${f.name}">${tpl}</template>
      <button type="button" class="gf-btn gf-ghost gf-add" data-add="${f.name}">+ ${escapeHtml(
        fill(s.addItem, { item })
      )}</button>
      <p class="gf-err" data-err="${f.name}" hidden=""></p>
    </div>`;
}

/**
 * La PLANTILLA de un bloque. Su índice es el literal `__i__`, que `reindex()` sustituye al
 * clonarla; el encabezado lo escribe el cliente, porque su número cambia cuando se quita un
 * bloque de en medio.
 */
function itemBlockHtml(f: FormField, subs: FormField[], s: FormStrings): string {
  return `<div class="gf-item" data-index="__i__">
      <div class="gf-item-head">
        <span class="gf-item-n"></span>
        <button type="button" class="gf-rm" data-rm="${f.name}" aria-label="${escapeHtml(
          s.removeItem
        )}">${escapeHtml(s.removeItem)}</button>
      </div>
      ${subs.map((sub) => fieldHtml(sub, s, itemKey(f.name, 0, sub.name).replace(".0.", ".__i__."))).join("\n")}
    </div>`;
}

function controlHtml(f: FormField, s: FormStrings, key = f.name): string {
  const id = `gf-${cssKey(key)}`;
  const base = `id="${id}" data-field="${escapeHtml(key)}"`;
  const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : "";

  switch (f.type) {
    case "textarea":
      return `<textarea ${base} class="gf-input" rows="4"${ph}></textarea>`;
    case "select":
      return `<select ${base} class="gf-input">
        <option value="">${escapeHtml(s.selectPlaceholder)}</option>
        ${(f.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
      </select>`;
    case "checkbox":
      return `<label class="gf-check-row"><input type="checkbox" ${base}> <span>${escapeHtml(
        f.placeholder || f.label
      )}${f.required ? ' <span class="gf-req">*</span>' : ""}</span></label>`;
    case "radio": {
      // Ojo: `validateValue` compara contra estas MISMAS etiquetas, así que las dos salen
      // del diccionario o un Sí/No en inglés no valida.
      const opts = f.options?.length ? f.options : [s.yes, s.no];
      return `<div class="gf-opts" ${base} data-kind="radio">
        ${opts
          .map(
            (o, i) =>
              `<label class="gf-opt"><input type="radio" name="${escapeHtml(key)}" value="${escapeHtml(o)}"${
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
                      `<td><label><input type="radio" name="${escapeHtml(key)}__${ri}" value="${escapeHtml(
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
      }><span class="gf-filenote" data-filenote="${escapeHtml(key)}"></span>`;
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

function clientScript(a: RenderFormArgs, s: FormStrings): string {
  // El schema viaja como TEXTO JSON dentro de un literal de JS, no como objeto inlineado:
  // así ningún valor puede escapar a código. Los `<` se van como < porque un
  // `</script>` dentro de una etiqueta cerraría el bloque antes de tiempo.
  //
  // Los textos viajan por el MISMO canal (`CFG.s`) en vez de interpolarse uno a uno al
  // construir el string: un solo punto de entrada, y nada que escapar dos veces.
  const cfgLiteral = JSON.stringify(
    JSON.stringify({ fields: a.fields, submitUrl: a.submitUrl, uploadUrl: a.uploadUrl, s }).replace(/</g, "\\u003c")
  );

  return `(function(){
var CFG = JSON.parse(${cfgLiteral});
var F = CFG.fields, S = CFG.s, form = document.getElementById("gf-form");
// Gemela de fill() en form-strings.ts: los textos con {placeholders} se resuelven aquí.
function fill(t, p){ for (var k in p) t = t.split("{" + k + "}").join(String(p[k])); return t; }
// Clave de idempotencia: se genera UNA vez al cargar y se reenvía en cada intento, así un
// doble clic o un reintento de red no crean dos respuestas ni dos fichas.
var IDEM = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
var steps = [].slice.call(document.querySelectorAll(".gf-step")), cur = 0;
var files = {};

function el(n){ return form.querySelector('[data-field="' + n + '"]'); }

// Una lista repetible: cada bloque se lee con las claves grupo.i.subcampo, y el conjunto
// viaja como JSON dentro de un string — el mismo truco que matrix, para no cambiar el tipo
// de lo que se guarda.
function readGroup(f){
  var wrap = form.querySelector('[data-items="' + f.name + '"]');
  if (!wrap) return [];
  var out = [], blocks = wrap.children, subs = f.fields || [];
  for (var i = 0; i < blocks.length; i++){
    // Scope LOCAL: un subcampo con showIf mira a sus hermanos del MISMO bloque, nunca a la
    // raíz ni a otro elemento. Es la misma regla que aplica el servidor.
    var scope = {}, item = {}, algo = false;
    for (var j = 0; j < subs.length; j++){
      var sub = subs[j];
      if (sub.showIf && scope[sub.showIf.field] !== sub.showIf.equals) continue;
      var v = readOne(sub, f.name + "." + i + "." + sub.name);
      scope[sub.name] = v; item[sub.name] = v;
      if (v) algo = true;
    }
    // Un bloque enteramente vacío no se manda: el servidor lo descartaría igual, y así los
    // índices de los errores coinciden con lo que se ve en pantalla.
    if (algo) out.push(item);
  }
  return out;
}

function readOne(f, key){
  if (f.type === "group") return JSON.stringify(readGroup(f));
  var n = el(key || f.name); if (!n) return "";
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

// ── Listas repetibles: clonar, quitar y renumerar ────────────────────────────────
// Todo pasa por reindex(): agregar y quitar sólo tocan el DOM y llaman aquí. Una sola
// función que reescriba las claves es lo que impide que un bloque quede con el data-field
// de otro — el modo de falla silencioso de clonar nodos con estado.
var KEYED = ["data-field","data-err","data-for","id","for","name","data-filenote"];

function reindex(g){
  var box = form.querySelector('[data-group="' + g + '"]');
  var wrap = form.querySelector('[data-items="' + g + '"]');
  if (!box || !wrap) return;
  var item = box.getAttribute("data-item") || "";
  var blocks = wrap.children;
  // Sustituye el índice VIEJO (un número, o el literal __i__ de la plantilla) por el nuevo.
  // SIN barras invertidas a propósito: este texto pasa por un template literal de TS, por
  // un literal de string de JS y sólo entonces llega al motor de regex. Un "\\d" acababa
  // siendo una "d" literal y reindex no reescribía NADA — se veía bien hasta que alguien
  // quitaba un bloque de en medio. Por eso [0-9] y el guión al final de la clase.
  var re = new RegExp("^(gf-)?" + g + "[.-](?:[0-9]+|__i__)[.-]");
  for (var i = 0; i < blocks.length; i++){
    var b = blocks[i];
    b.setAttribute("data-index", i);
    var head = b.querySelector(".gf-item-n");
    if (head) head.textContent = fill(S.itemHeading, { item: item, n: i + 1 });
    var nodes = b.querySelectorAll("[" + KEYED.join("],[") + "]");
    for (var k = 0; k < nodes.length; k++){
      for (var a = 0; a < KEYED.length; a++){
        var attr = KEYED[a], v = nodes[k].getAttribute(attr);
        if (v == null) continue;
        var m = v.match(re);
        if (!m) continue;
        var pre = m[1] || "", sep = v.charAt(m[0].length - 1);
        nodes[k].setAttribute(attr, pre + g + sep + i + sep + v.slice(m[0].length));
      }
    }
  }
  var max = parseInt(box.getAttribute("data-max"), 10) || 10;
  var add = box.querySelector('[data-add="' + g + '"]');
  if (add) add.hidden = (blocks.length >= max);
  // Con un solo bloque y mínimo 1, quitarlo no tiene sentido.
  var min = parseInt(box.getAttribute("data-min"), 10) || 0;
  for (var q = 0; q < blocks.length; q++){
    var rm = blocks[q].querySelector('[data-rm="' + g + '"]');
    if (rm) rm.hidden = (blocks.length <= min);
  }
}

function addItem(g){
  var tpl = form.querySelector('[data-tpl="' + g + '"]');
  var wrap = form.querySelector('[data-items="' + g + '"]');
  var box = form.querySelector('[data-group="' + g + '"]');
  if (!tpl || !wrap || !box) return;
  var max = parseInt(box.getAttribute("data-max"), 10) || 10;
  if (wrap.children.length >= max) return;
  wrap.appendChild(tpl.content.cloneNode(true));
  reindex(g);
  applyVisibility();
}

form.addEventListener("click", function(ev){
  var t = ev.target;
  if (!t || !t.getAttribute) return;
  var g = t.getAttribute("data-add");
  if (g){ addItem(g); return; }
  g = t.getAttribute("data-rm");
  if (g){
    var b = t.parentNode && t.parentNode.parentNode;
    if (b && b.parentNode){ b.parentNode.removeChild(b); reindex(g); applyVisibility(); }
  }
});

// Misma regla que el servidor: igualdad estricta de texto contra el campo del que depende.
function visible(f, d){ return !f.showIf || d[f.showIf.field] === f.showIf.equals; }

function applyVisibility(){
  var d = readAll();
  for (var i=0;i<F.length;i++){
    var wrap = form.querySelector('.gf-field[data-for="' + F[i].name + '"]');
    if (wrap) wrap.hidden = !visible(F[i], d);
    if (F[i].type === "group") itemVisibility(F[i]);
  }
  progress(d);
}

// La visibilidad DENTRO de un bloque se resuelve contra sus propios hermanos. Si mirara el
// scope de la raiz, el bloque 3 se escondería o no según lo que contestó el bloque 1.
function itemVisibility(f){
  var box = form.querySelector('[data-items="' + f.name + '"]');
  if (!box) return;
  var subs = f.fields || [], blocks = box.children;
  for (var i=0;i<blocks.length;i++){
    var scope = {};
    for (var j=0;j<subs.length;j++){
      var sub = subs[j], key = f.name + "." + i + "." + sub.name;
      var vis = !sub.showIf || scope[sub.showIf.field] === sub.showIf.equals;
      var w = blocks[i].querySelector('.gf-field[data-for="' + key + '"]');
      if (w) w.hidden = !vis;
      scope[sub.name] = vis ? readOne(sub, key) : "";
    }
  }
}

function progress(d){
  var bar = document.getElementById("gf-bar-fill"); if (!bar) return;
  var req = F.filter(function(f){ return f.required && visible(f, d); });
  var done = req.filter(function(f){ return d[f.name]; }).length;
  var pct = req.length ? Math.round(done * 100 / req.length) : 0;
  bar.style.width = pct + "%";
  document.getElementById("gf-count").textContent = fill(S.stepOf, { n: cur+1, total: steps.length });
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
    if (f.type === "group"){ if (!groupOk(f)) ok = false; continue; }
    if (f.required && !d[f.name]){ showError(f.name, fill(S.required, { label: f.label })); ok = false; }
  }
  return ok;
}

// Mínimo de elementos y "requerido vacío" dentro de cada bloque. Los formatos (correo,
// teléfono) siguen siendo del servidor, igual que en la raíz: una sola redacción.
function groupOk(f){
  var box = form.querySelector('[data-group="' + f.name + '"]');
  var wrap = form.querySelector('[data-items="' + f.name + '"]');
  if (!box || !wrap) return true;
  var items = readGroup(f), ok = true;
  var min = parseInt(box.getAttribute("data-min"), 10) || 0;
  if (items.length < min){
    showError(f.name, fill(S.minItems, { label: f.label, n: min }));
    return false;
  }
  var subs = f.fields || [];
  for (var i=0;i<items.length;i++){
    var scope = {};
    for (var j=0;j<subs.length;j++){
      var sub = subs[j];
      if (sub.showIf && scope[sub.showIf.field] !== sub.showIf.equals) continue;
      var key = f.name + "." + i + "." + sub.name, v = readOne(sub, key);
      scope[sub.name] = v;
      if (sub.required && !v){ showError(key, fill(S.required, { label: sub.label })); ok = false; }
    }
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
  if (note) note.textContent = S.uploading;
  fetch(CFG.uploadUrl, { method: "POST", body: fd })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j && j.ok && j.fileId){ files[name] = j.fileId; if (note) note.textContent = j.name || S.fileReady; }
      else { if (note) note.textContent = ""; showError(name, (j && j.error) || S.uploadFailed); }
    })
    .catch(function(){ if (note) note.textContent = ""; showError(name, S.uploadFailed); });
}

form.addEventListener("submit", function(ev){
  ev.preventDefault();
  if (!stepOk()) return;
  var send = document.getElementById("gf-send");
  send.disabled = true; send.textContent = S.sending;
  var hp = form.querySelector('[name="_hp"]');
  fetch(CFG.submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _idem: IDEM, _hp: hp ? hp.value : "", data: readAll() })
  })
  .then(function(r){ return r.json(); })
  .then(function(j){
    send.disabled = false; send.textContent = S.send;
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
    if (!keys.length) showError("_form", S.submitFailed);
    // El error puede estar en un paso anterior: llevar a la persona ahí, no dejarla
    // mirando un botón que no hace nada.
    if (first){
      for (var s=0;s<steps.length;s++){
        if (steps[s].querySelector('[data-field="' + first + '"]')){ goto(s); showError(first, errs[first]); break; }
      }
    }
  })
  .catch(function(){
    send.disabled = false; send.textContent = S.send;
    showError("_form", S.offline);
  });
});

// Los bloques de cada lista NO vienen en el HTML: el markup sólo trae la plantilla inerte.
// Se siembran aquí, uno por el mínimo (y siempre al menos uno, o la lista se ve como un
// botón suelto sin explicar qué hace).
for (var gi=0; gi<F.length; gi++){
  if (F[gi].type !== "group") continue;
  var gbox = form.querySelector('[data-group="' + F[gi].name + '"]');
  var n = gbox ? (parseInt(gbox.getAttribute("data-min"), 10) || 0) : 0;
  if (n < 1) n = 1;
  for (var gj=0; gj<n; gj++) addItem(F[gi].name);
}

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
.gf-group>.gf-label{margin-bottom:10px}
.gf-items{display:flex;flex-direction:column;gap:12px}
.gf-item{border:1px solid var(--line);border-radius:10px;padding:14px 14px 2px;background:var(--paper)}
.gf-item-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.gf-item-n{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--accent-ink)}
.gf-rm{font:inherit;font-size:13px;color:var(--muted);background:none;border:0;padding:4px 8px;border-radius:6px;cursor:pointer}
.gf-rm:hover{background:#fff;color:var(--req)}
.gf-rm[hidden]{display:none}
.gf-add{margin-top:12px;font-size:14px;padding:8px 16px}
.gf-add[hidden]{display:none}
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
