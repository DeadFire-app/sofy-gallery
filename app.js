/* Sofy — FRONT (oscuro + fucsia) con Splash Pro
   - Mantiene splash (3 canvases) + capas extra
   - Timeline 4.6–5.2s: letras -> shimmer -> progreso -> fade out
   - Carga data.json
   - Búsqueda multi-término
   - Paginación
   - Click en card -> Modal con Tela · Talles · Precio
*/

const PAGE_SIZE = 10;

const $ = (sel, ctx=document)=>ctx.querySelector(sel);
const $$ = (sel, ctx=document)=>Array.from(ctx.querySelectorAll(sel));
const esc = (s)=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

/* DOM refs */
const grid = $('#gallery');
const pager = $('#pagination');
const searchInput = $('#searchInput');
const countInfo = $('#countInfo');
$('#year').textContent = new Date().getFullYear();

let DATA = [];
let filtered = [];
let page = 1;

/* ===== Splash: timeline + progreso ===== */
const splash = $('#splash');
const progBar = $('#s-progress');
let dataLoaded = false;

function setProgress(p){
  const v = Math.max(0, Math.min(100, p|0));
  if (progBar) progBar.style.width = v + '%';
}

function splashOut(){
  if (!splash || splash.classList.contains('out')) return;
  splash.classList.add('out');
  setTimeout(()=> splash.remove(), 700);
}

// Orquestación: aseguramos mínimo ~4.6s visibles
const SPLASH_MIN_MS = 4600;
const t0 = performance.now();
let fakeTicker;

function startFakeTicker(){
  // si la data tarda poco, hacemos un fill visual elegante
  let p = 0;
  fakeTicker = setInterval(()=>{
    if (dataLoaded) { clearInterval(fakeTicker); return; }
    p = Math.min(92, p + Math.random()*6 + 1); // llega hasta ~92%
    setProgress(p);
  }, 140);
}

function finishSplash(){
  const elapsed = performance.now() - t0;
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(()=> splashOut(), wait);
}

startFakeTicker();

/* ===== Data ===== */
async function load(){
  try{
    const res = await fetch('data.json?ts=' + Date.now());
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('data.json debe ser un array');
    DATA = json;
    dataLoaded = true;
    setProgress(100);
    applyFilter();
  }catch(err){
    console.error(err);
    grid.innerHTML = `<p style="padding:24px;color:#ff9ac4">No se pudo cargar <code>data.json</code>.</p>`;
    dataLoaded = true;
    setProgress(100);
  }finally{
    finishSplash();
  }
}

/* ===== Filter ===== */
function applyFilter(){
  const q = (searchInput.value||'').toLowerCase().trim();
  if (!q) filtered = [...DATA];
  else{
    const terms = q.split(/\s+/).filter(Boolean);
    filtered = DATA.filter(it=>{
      const hay = (it.title + ' ' + it.description + ' ' + (it.tags||[]).join(' ')).toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }
  page = 1;
  render();
}
searchInput.addEventListener('input', debounce(applyFilter, 200));
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); } }

/* ===== Render ===== */
const io = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{ if(e.isIntersecting) e.target.classList.add('reveal'); });
},{threshold:.08, rootMargin:'0px 0px -10% 0px'});

function render(){
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (page-1)*PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, total);

  countInfo.textContent = `${total ? (start+1) : 0}–${end} de ${total}`;

  const slice = filtered.slice(start, end);
  grid.innerHTML = slice.map(cardHTML).join('');

  // IO + click modal
  $$('.card', grid).forEach((el, i)=>{
    io.observe(el);
    el.addEventListener('click', ()=> openModal(slice[i]));
    el.addEventListener('keydown', ev=>{
      if (ev.key==='Enter' || ev.key===' ') { ev.preventDefault(); openModal(slice[i]); }
    });
  });

  // pager
  let html = btn('‹', Math.max(1, page-1), false, page===1);
  for(let i=1;i<=pages;i++){
    if(i===1 || i===pages || Math.abs(i-page)<=2) html += btn(i,i,i===page);
    else if(Math.abs(i-page)===3) html += `<span style="padding:10px 6px;opacity:.4">…</span>`;
  }
  html += btn('›', Math.min(pages, page+1), false, page===pages);
  pager.innerHTML = html;
  $$('#pagination button[data-p]').forEach(b=>{
    b.addEventListener('click', ()=>{
      page = Number(b.dataset.p);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function btn(label, p, active=false, disabled=false){
  return `<button ${disabled?'disabled':''} class="${active?'active':''}" data-p="${p}">${label}</button>`;
}

function cardHTML(item){
  const tags = (item.tags||[]).slice(0,4).map(t=>`<span class="tag">${esc(t)}</span>`).join('');
  return `
    <article class="card" role="button" tabindex="0" aria-label="${esc(item.title)}">
      <img class="card-img" loading="lazy" src="${esc(item.image)}" alt="${esc(item.title)}"/>
      <div class="card-body">
        <h3 class="card-title">${esc(item.title)}</h3>
        <p class="card-desc">${esc(item.description)}</p>
        <div class="tags">${tags}</div>
      </div>
    </article>
  `;
}

/* ===== Modal ===== */
function parseDescription(desc=''){
  const out = { fabric:null, sizes:[], price:null };
  const m1 = desc.match(/Tela:\s*([^·\n]+)/i);     if(m1) out.fabric = m1[1].trim();
  const m2 = desc.match(/Talles:\s*([^·\n]+)/i);   if(m2) out.sizes = m2[1].split(/,\s*/).map(s=>s.trim());
  const m3 = desc.match(/Precio:\s*\$?\s*([\d.,]+)/i); if(m3) out.price = m3[1].replace(/\./g,'').replace(',', '.');
  return out;
}

function openModal(item){
  const m = parseDescription(item.description||'');
  ensureModal();
  const wrap = $('.modal');
  const body = wrap.querySelector('.modal-body');

  body.innerHTML = `
    <div class="modal-card">
      <img class="modal-img" src="${esc(item.image)}" alt="${esc(item.title)}"/>
      <div class="modal-panel">
        <div class="modal-title">${esc(item.title)}</div>
        <div class="meta">
          <div class="meta-row"><div class="meta-key">Tela</div><div>${esc(m.fabric||'-')}</div></div>
          <div class="meta-row"><div class="meta-key">Talles</div><div>${esc((m.sizes||[]).join(', ')||'-')}</div></div>
          <div class="meta-row"><div class="meta-key">Precio</div><div class="price">${m.price?('$'+m.price+' ARS'):'-'}</div></div>
        </div>
        <div style="opacity:.72;font-size:13px">${esc(item.description||'')}</div>
        <div class="tags" style="margin-top:14px">${(item.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>
      <button class="modal-close" aria-label="Cerrar">×</button>
    </div>
  `;
  wrap.classList.add('open');
  wrap.querySelector('.modal-close').onclick = ()=> wrap.classList.remove('open');
  wrap.onclick = (e)=>{ if (e.target === wrap) wrap.classList.remove('open'); };
}

function ensureModal(){
  if ($('.modal')) return;
  const div = document.createElement('div');
  div.className = 'modal';
  div.innerHTML = `<div class="modal-body"></div>`;
  document.body.appendChild(div);
}

/* ===== Init ===== */
load();