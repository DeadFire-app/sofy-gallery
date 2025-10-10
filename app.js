/* ==========================================================
   catálogo sofy — Splash EXÓTICO mejorado + fetch + filtro + paginación
   ========================================================== */

// ---------- Utilidades ----------
const escapeHTML = (s) => String(s ?? "")
  .replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");

const stripAccents = (s="") => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");

const STATE = {
  all: [],
  filtered: [],
  page: 1,
  perPage: 10,
  query: ""
};

// ---------- Splash EXÓTICO (triple canvas) ----------
const splashEl = document.getElementById("splash");
const cBg = document.getElementById("c-bg");
const cMid = document.getElementById("c-mid");
const cFg = document.getElementById("c-fg");

let ctxBg, ctxMid, ctxFg, W, H, rafBg, rafMid, rafFg;
const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
const MIN_SPLASH_MS = 3200; // <-- más largo y cinematográfico
let t0 = performance.now();
let dataReady = false, minTimeOk = false;

function resizeAll(){
  [cBg, cMid, cFg].forEach(c=>{
    c.width = Math.floor(window.innerWidth * DPR);
    c.height= Math.floor(window.innerHeight * DPR);
    const ctx = c.getContext("2d");
    ctx.setTransform(DPR,0,0,DPR,0,0);
  });
  W = window.innerWidth; H = window.innerHeight;
}

// Fondo: anillos iridiscentes + blobs suaves
function loopBg(t=0){
  ctxBg.clearRect(0,0,W,H);

  // anillos concéntricos
  const cx = W/2, cy = H/2;
  for (let i=0;i<6;i++){
    const r = 120 + i*70 + 8*Math.sin((t*.0015)+i);
    const grad = ctxBg.createConicGradient((t*.0003)+i*0.6, cx, cy);
    grad.addColorStop(0, "rgba(233,30,99,.08)");
    grad.addColorStop(.33, "rgba(244,143,177,.10)");
    grad.addColorStop(.66, "rgba(248,187,208,.08)");
    grad.addColorStop(1, "rgba(233,30,99,.08)");
    ctxBg.strokeStyle = grad;
    ctxBg.lineWidth = 12 - i;
    ctxBg.beginPath();
    ctxBg.arc(cx, cy, r, 0, Math.PI*2);
    ctxBg.stroke();
  }

  // blob central respirando
  const R = 120 + 18*Math.sin(t*.002);
  const k = .552284749831;
  const r = R*(1+.07*Math.sin(t*.0032));
  ctxBg.fillStyle = "rgba(233,30,99,.12)";
  ctxBg.beginPath();
  ctxBg.moveTo(cx+r, cy);
  ctxBg.bezierCurveTo(cx+r, cy+k*r, cx+k*r, cy+r, cx, cy+r);
  ctxBg.bezierCurveTo(cx-k*r, cy+r, cx-r, cy+k*r, cx-r, cy);
  ctxBg.bezierCurveTo(cx-r, cy-k*r, cx-k*r, cy-r, cx, cy-r);
  ctxBg.bezierCurveTo(cx+k*r, cy-r, cx+r, cy-k*r, cx+r, cy);
  ctxBg.closePath(); ctxBg.fill();

  rafBg = requestAnimationFrame(loopBg);
}

// Medio: cometas con estela + sparks
const comets = [];
function resetComets(){
  comets.length = 0;
  const count = Math.min(22, Math.floor((W*H)/38000));
  for(let i=0;i<count;i++){
    comets.push({
      x: Math.random()*W, y: Math.random()*H,
      vx: (Math.random()-.5)*2, vy: (Math.random()-.5)*2,
      life: 0, max: 240 + Math.random()*160,
      hue: 330 + Math.random()*20
    });
  }
}
function loopMid(t=0){
  // efecto “trail”: capa translúcida que desvanece lentamente
  ctxMid.fillStyle = "rgba(255,255,255,.08)";
  ctxMid.globalCompositeOperation = "source-over";
  ctxMid.fillRect(0,0,W,H);

  ctxMid.globalCompositeOperation = "lighter";
  for(const c of comets){
    c.x += c.vx; c.y += c.vy; c.life++;
    if (c.x< -50 || c.y<-50 || c.x>W+50 || c.y>H+50 || c.life>c.max){
      // respawn
      c.x = Math.random()*W; c.y = Math.random()*H;
      c.vx = (Math.random()-.5)*2.2; c.vy = (Math.random()-.5)*2.2;
      c.life = 0; c.max = 240 + Math.random()*160;
      c.hue = 330 + Math.random()*20;
    }
    const r = 1.8 + 1.8*Math.sin((t*.004)+c.life*.08);
    const grad = ctxMid.createRadialGradient(c.x, c.y, 0, c.x, c.y, 22);
    grad.addColorStop(0, `hsla(${c.hue}, 85%, 60%, .55)`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctxMid.fillStyle = grad;
    ctxMid.beginPath(); ctxMid.arc(c.x, c.y, r*10, 0, Math.PI*2); ctxMid.fill();

    // chispas ocasionales
    if (c.life % 60 === 0){
      for(let k=0;k<3;k++){
        const ang = Math.random()*Math.PI*2;
        const d = 10 + Math.random()*18;
        const sx = c.x + Math.cos(ang)*d, sy = c.y + Math.sin(ang)*d;
        ctxMid.fillStyle = `hsla(${c.hue}, 85%, 60%, .9)`;
        ctxMid.fillRect(sx, sy, 1.8, 1.8);
      }
    }
  }
  rafMid = requestAnimationFrame(loopMid);
}

// Frente: destellos suaves que orbitan el logo
const flares = [];
function resetFlares(){
  flares.length = 0;
  const cx = W/2, cy = H*0.48;
  for(let i=0;i<8;i++){
    flares.push({
      ang: Math.random()*Math.PI*2,
      rad: 90 + Math.random()*140,
      speed: .006 + Math.random()*.006,
      size: 14 + Math.random()*22
    });
  }
}
function loopFg(t=0){
  ctxFg.clearRect(0,0,W,H);
  const cx = W/2, cy = H*0.48;

  for(const f of flares){
    const x = cx + Math.cos(f.ang)*f.rad;
    const y = cy + Math.sin(f.ang)*f.rad;
    const g = ctxFg.createRadialGradient(x,y,0,x,y,f.size);
    g.addColorStop(0,"rgba(233,30,99,.55)");
    g.addColorStop(1,"rgba(233,30,99,0)");
    ctxFg.fillStyle = g;
    ctxFg.beginPath(); ctxFg.arc(x,y,f.size,0,Math.PI*2); ctxFg.fill();
    f.ang += f.speed;
  }

  rafFg = requestAnimationFrame(loopFg);
}

function initSplash(){
  if (!cBg || !cMid || !cFg) return;
  ctxBg = cBg.getContext("2d");
  ctxMid= cMid.getContext("2d");
  ctxFg = cFg.getContext("2d");
  resizeAll();
  resetComets();
  resetFlares();

  window.addEventListener("resize", () => {
    resizeAll(); resetComets(); resetFlares();
  }, { passive:true });

  rafBg = requestAnimationFrame(loopBg);
  rafMid= requestAnimationFrame(loopMid);
  rafFg = requestAnimationFrame(loopFg);

  // protección “no flicker” y más duración
  t0 = performance.now();
  setTimeout(()=>{ minTimeOk = true; maybeHideSplash(); }, MIN_SPLASH_MS);
}
function maybeHideSplash(){
  if (!splashEl) return;
  if (dataReady && minTimeOk){
    cancelAnimationFrame(rafBg); cancelAnimationFrame(rafMid); cancelAnimationFrame(rafFg);
    splashEl.classList.add("is-hiding");
    setTimeout(()=> splashEl.remove(), 900);
  }
}

// ---------- Búsqueda (AND, acentos-insensible) ----------
const searchInput = document.getElementById("searchInput");
const countInfo = document.getElementById("countInfo");
const galleryEl = document.getElementById("gallery");
const paginationEl = document.getElementById("pagination");

function tokenize(q){
  return stripAccents(q.toLowerCase()).split(/[\s,]+/).filter(Boolean).slice(0,10);
}
function matchesQuery(item, tokens){
  if (tokens.length===0) return true;
  const hay = stripAccents(
    `${item.title||""} ${item.description||""} ${(item.tags||[]).join(" ")}`
  ).toLowerCase();
  return tokens.every(tok => hay.includes(tok));
}
function applyFilter(){
  const toks = tokenize(STATE.query);
  STATE.filtered = STATE.all.filter(it => matchesQuery(it, toks));
  STATE.page = 1;
  render();
}
let debounceId;
function onSearchInput(){
  clearTimeout(debounceId);
  debounceId = setTimeout(() => {
    STATE.query = searchInput.value.trim();
    applyFilter();
  }, 160);
}

// ---------- Paginación ----------
function totalPages(){ return Math.max(1, Math.ceil(STATE.filtered.length / STATE.perPage)); }
function currentSlice(){
  const start = (STATE.page-1)*STATE.perPage;
  return STATE.filtered.slice(start, start+STATE.perPage);
}
function gotoPage(p){
  const tp = totalPages();
  STATE.page = Math.min(Math.max(1,p), tp);
  renderGallery(); renderPagination();
}
function mkBtn(label, target, disabled=false, active=false){
  const b = document.createElement("button");
  b.className = "page-btn" + (active?" is-active":"");
  b.textContent = label;
  if (disabled) b.disabled = true;
  b.addEventListener("click", () => gotoPage(target));
  return b;
}
function ellipsis(){
  const span = document.createElement("span");
  span.className = "page-btn"; span.setAttribute("aria-hidden","true");
  span.textContent = "…"; span.style.cursor="default";
  return span;
}
function renderPagination(){
  const p = STATE.page, tp = totalPages();
  paginationEl.innerHTML = "";

  // Prev
  paginationEl.appendChild(mkBtn("<", p-1, p===1));

  // Ventana inteligente
  const win = 2;
  const push = (i)=> paginationEl.appendChild(mkBtn(String(i), i, false, i===p));
  if (tp <= 10){
    for(let i=1;i<=tp;i++) push(i);
  } else {
    push(1);
    if (p - win > 2) paginationEl.appendChild(ellipsis());
    for (let i=Math.max(2,p-win); i<=Math.min(tp-1,p+win); i++) push(i);
    if (p + win < tp-1) paginationEl.appendChild(ellipsis());
    push(tp);
  }

  // Next
  paginationEl.appendChild(mkBtn(">", p+1, p===tp));
}

// ---------- Render galería (solo imagen vertical) ----------
function renderGallery(){
  const slice = currentSlice();
  galleryEl.innerHTML = "";
  for (const item of slice){
    const card = document.createElement("article");
    card.className = "card"; card.tabIndex = 0;

    const media = document.createElement("div");
    media.className = "media";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = escapeHTML(item.title || "imagen");
    img.src = String(item.image || "");

    media.appendChild(img);
    card.appendChild(media);
    galleryEl.appendChild(card);
  }

  const total = STATE.filtered.length;
  const start = (STATE.page-1)*STATE.perPage + 1;
  const end = Math.min(STATE.page*STATE.perPage, total);
  countInfo.textContent = total ? `${start}–${end} de ${total}` : `0 resultados`;
}
function render(){ renderGallery(); renderPagination(); }

// ---------- Data + tiempo real ----------
const DATA_URL = "./data.json";
let lastJSON = "";

async function fetchData(){
  const res = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache:"no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error("data.json debe ser un array");

  const str = JSON.stringify(arr);
  if (str !== lastJSON){
    lastJSON = str;
    STATE.all = arr.slice();
    applyFilter();
  } else {
    render();
  }
}
function startPolling(){
  setInterval(() => {
    fetchData().catch(e => console.error("[poll]", e));
  }, 20000);
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("year").textContent = new Date().getFullYear();
  if (searchInput) searchInput.addEventListener("input", onSearchInput);

  // Splash
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches){
    minTimeOk = true; dataReady = true; if (splashEl){ splashEl.remove(); }
  } else {
    initSplash();
  }

  // Data
  fetchData()
    .then(() => { dataReady = true; maybeHideSplash(); startPolling(); })
    .catch(err => {
      console.error("[fetch] ", err);
      dataReady = true; maybeHideSplash();
      const el = document.createElement("div");
      el.style.color = "#e91e63"; el.style.margin = "8px 0 16px";
      el.textContent = "No se pudo cargar data.json";
      galleryEl.before(el);
    });
});