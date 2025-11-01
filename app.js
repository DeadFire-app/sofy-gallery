/* helpers */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

/* state */
let DATA = { version:1, lastUpdated:"", items: [] };
let VIEW = { page:1, pageSize:10 };
let CART = JSON.parse(localStorage.getItem('cart_v1')||'[]');

/* detail modal state (ahora con multiple sizes) */
let DETAIL_STATE = {
  currentItem: null,
  selectedImageIndex: 0,
  selectedSizes: new Set()
};

/* Splash control */
let __SPLASH_CLOSED = false;
let __SPLASH_FALLBACK_TMR = null;
function finishSplash(){
  if (__SPLASH_CLOSED) return;
  __SPLASH_CLOSED = true;
  if (__SPLASH_FALLBACK_TMR) {
    clearTimeout(__SPLASH_FALLBACK_TMR);
    __SPLASH_FALLBACK_TMR = null;
  }
  const minVisible = 2300;
  setTimeout(()=>{
    const el = document.getElementById('splash');
    if (!el) return;
    el.classList.add('hide');
    el.setAttribute('data-anim-paused','1');
    el.style.pointerEvents = 'none';
    setTimeout(()=> { try{ el.remove(); } catch(e){ if (el) el.style.display='none'; } }, 1200);
  }, minVisible);
  __SPLASH_FALLBACK_TMR = setTimeout(()=>{
    const el = document.getElementById('splash');
    if (!el) return;
    el.classList.add('hide');
    el.setAttribute('data-anim-paused','1');
    try{ el.remove(); } catch(e){ if (el) el.style.display='none'; }
  }, 8000);
}

/* DOM Ready */
document.addEventListener('DOMContentLoaded', ()=>{
  $('#year') && ($('#year').textContent = new Date().getFullYear());
  bindMenu();
  bindCartButtons();
  bindSearch();
  bindGalleryDelegation();
  bindGlobalModalClosers();
  bindCartPanelClose();
  bindReceiptModal(); // nuevo: bind para modal de comprobante
  load();
  setRealVh();
  addEventListener('resize', setRealVh);
  addEventListener('orientationchange', setRealVh);

  // Attach pay link handler if exists
  const payLink = $('#payLink');
  if (payLink) {
    payLink.addEventListener('click', (e) => {
      e.preventDefault();
      handleCheckout(e);
    });
  }

  // If we are on the "return from payment" flow, render comprobante upload area if element exists
  const uploadSection = $('#comprobanteUpload');
  const info = JSON.parse(localStorage.getItem('checkoutInfo')||'{}');
  if (uploadSection && info && Array.isArray(info.items) && info.items.length) {
    renderComprobanteUpload(uploadSection, info);
  }
});

/* cargar data */
async function load(){
  try{
    const res = await fetch('data.json?ts=' + Date.now());
    const json = await res.json();
    DATA = Array.isArray(json) ? { version:1, lastUpdated:new Date().toISOString(), items: json } : (json || {version:1, items:[]});
  }catch(_){
    DATA = { version:1, lastUpdated:"", items: [] };
  }
  render();
  finishSplash();
}

/* render principal */
function render(){
  const q = ($('#searchInput') && $('#searchInput').value || '').trim().toLowerCase();
  const items = (DATA.items || []).filter(x=>{
    if (x.deleted) return false;
    if (!q) return true;
    const blob = [x.title, x.description, ...(x.tags||[])].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(p => blob.includes(p));
  });
  $('#countInfo') && ($('#countInfo').textContent = `${items.length} items`);
  const totalPages = Math.max(1, Math.ceil(items.length / VIEW.pageSize));
  if (VIEW.page > totalPages) VIEW.page = totalPages;
  const start = (VIEW.page-1) * VIEW.pageSize;
  const pageItems = items.slice(start, start + VIEW.pageSize);
  $('#gallery').innerHTML = pageItems.map(cardHTML).join('');
  renderPagination(totalPages);
}

/* tarjetas */
function cardHTML(item){
  const imgs = Array.isArray(item.images) && item.images.length ? item.images : (item.image ? [item.image] : []);
  const cover = esc(imgs[0] || '');
  const fileBase = (item.title || 'imagen').toLowerCase().replace(/[^\w\-]+/g, '-').slice(0,50);
  const tags = (item.tags||[]).slice(0,3).map(t=>`<span class="tag">${esc(t)}</span>`).join('');
  return `
    <article class="card" data-id="${esc(item.id)}" tabindex="0" aria-labelledby="title-${esc(item.id)}">
      <div class="dl-wrap">
        <button class="dl-btn" data-url="${cover}" data-name="${fileBase}.jpg" title="Descargar" aria-label="Descargar imagen">
          <svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM7 10h4V4h2v6h4l-5 5-5-5z"/></svg>
        </button>
        <img class="card-img" loading="lazy" src="${cover}" alt="${esc(item.title)}"/>
      </div>
      <div class="card-body">
        <h3 class="card-title" id="title-${esc(item.id)}">${esc(item.title)}</h3>
        <p class="card-desc truncate-2">${esc(item.description)}</p>
        <div class="tags">${tags}</div>
        <div class="card-cta">
          <button class="mini-btn btn-more">Ver detalle</button>
          <button class="mini-btn btn-add">Agregar</button>
        </div>
      </div>
    </article>
  `;
}

/* Delegación en #gallery */
function bindGalleryDelegation(){
  const gallery = $('#gallery');
  if (!gallery) return;
  gallery.addEventListener('click', async (e) => {
    const dl = e.target.closest('.dl-btn');
    if (dl){
      e.stopPropagation();
      await handleDownloadButton(dl);
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const item = (DATA.items||[]).find(x => String(x.id) === String(id));
    if (!item) return;
    const isAdd = e.target.closest('.btn-add');
    const isMore = e.target.closest('.btn-more');
    if (isAdd || isMore){
      e.stopPropagation();
      openDetail(item);
      return;
    }
    openDetail(item);
  });
  gallery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      const item = (DATA.items||[]).find(x => String(x.id) === String(id));
      if (!item) return;
      openDetail(item);
    }
  });
}

/* descarga (handler reutilizable) */
async function handleDownloadButton(btn){
  const url = btn.dataset.url;
  const name = btn.dataset.name || 'imagen.jpg';
  try{
    const res = await fetch(url, { mode:'cors' });
    if (!res.ok) throw new Error('no-ok');
    const blob = await res.blob();
    let filename = name;
    try{
      const cd = res.headers.get && res.headers.get('content-disposition');
      if (cd){
        const m = /filename\*?=(?:UTF-8'')?["']?([^;"']+)/i.exec(cd);
        if (m) filename = decodeURIComponent(m[1]);
      }
    }catch(_){}
    const href = URL.createObjectURL(blob);
    triggerDownload(href, filename);
    setTimeout(()=> URL.revokeObjectURL(href), 4000);
  }catch(err){
    window.open(url, '_blank', 'noopener');
  }
}

function triggerDownload(href, filename){
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* paginación */
function renderPagination(total){
  const pag = $('#pagination');
  const cells = [];
  const max = Math.min(total, 10);
  for (let i=1;i<=max;i++){
    cells.push(`<button class="page-btn ${i===VIEW.page ? 'active' : ''}" data-p="${i}">${i}</button>`);
  }
  pag.innerHTML = cells.length ? cells.join('') : '';
  pag.querySelectorAll('.page-btn').forEach(b => b.addEventListener('click', ()=>{
    VIEW.page = Number(b.dataset.p); render();
  }));
}

/* debounce búsqueda */
function debounce(fn, wait=250){
  let t;
  return (...args)=>{ clearTimeout(t); t = setTimeout(()=> fn.apply(this, args), wait); };
}
function bindSearch(){
  const input = $('#searchInput');
  if (!input) return;
  input.addEventListener('input', debounce(()=>{
    VIEW.page = 1;
    render();
  }, 220));
}

/* Detalle: slider + thumbs + multiple talles */
function openDetail(item){
  if (!item) return;
  DETAIL_STATE.currentItem = item;
  DETAIL_STATE.selectedImageIndex = 0;
  DETAIL_STATE.selectedSizes = new Set();
  $('#detailTitle') && ($('#detailTitle').textContent = item.title || '');
  $('#detailDesc') && ($('#detailDesc').textContent = item.description || '');
  $('#detailTags') && ($('#detailTags').innerHTML = (item.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(''));
  const imgs = Array.isArray(item.images) && item.images.length ? item.images : (item.image ? [item.image] : []);
  $('#detailImages') && ($('#detailImages').innerHTML = sliderWithThumbsHTML(imgs));
  const sizes = Array.isArray(item.sizes) && item.sizes.length ? item.sizes : ['S','M','L','XL'];
  const sizesWrap = $('#detailSizes');
  if (sizesWrap) sizesWrap.innerHTML = sizes.map(s=>`<button class="size-btn" data-size="${esc(s)}">${esc(s)}</button>`).join('');
  bindSliderSelectable($('#detailImages'));
  const sizeButtons = (sizesWrap && Array.from(sizesWrap.querySelectorAll('.size-btn'))) || [];
  sizeButtons.forEach(btn=>{
    btn.onclick = (e) => {
      e.stopPropagation();
      const size = btn.dataset.size;
      if (!size) return;
      if (DETAIL_STATE.selectedSizes.has(size)){
        DETAIL_STATE.selectedSizes.delete(size);
        btn.classList.remove('selected');
      } else {
        DETAIL_STATE.selectedSizes.add(size);
        btn.classList.add('selected');
      }
      btn.setAttribute('aria-pressed', DETAIL_STATE.selectedSizes.has(size) ? 'true' : 'false');
    };
    btn.onkeydown = (e) => { if (e.key==='Enter') btn.click(); };
    btn.setAttribute('aria-pressed','false');
  });
  $('#addToCart').onclick = () => {
    const sizesSelectedArray = Array.from(DETAIL_STATE.selectedSizes || []);
    if (!sizesSelectedArray.length){
      flashSizeWarning();
      return;
    }
    const selectedImg = (imgs[DETAIL_STATE.selectedImageIndex] || imgs[0] || (item.image||''));
    sizesSelectedArray.forEach(sz => {
      addCart({ id: item.id, title: item.title, price: Number(item.price||0), image: selectedImg, qty: 1, size: sz });
    });
    DETAIL_STATE.selectedSizes.clear();
    const dlg = $('#detailModal');
    try { dlg.close(); } catch(e){ dlg.classList.remove('open'); }
    openCart();
  };
  const dlg = $('#detailModal');
  if (dlg) { if (typeof dlg.showModal==='function'){ try{ dlg.showModal(); } catch(e){ dlg.classList.add('open'); } } else { dlg.classList.add('open'); } }
}

function sliderWithThumbsHTML(arr){
  const slides = arr.map((u,i)=>`<div class="slide" data-i="${i}" style="flex:0 0 100%"><img loading="lazy" src="${esc(u)}" alt="foto ${i+1}"/></div>`).join('');
  const thumbs = arr.map((u,i)=>`<button class="thumb" data-i="${i}" aria-label="Seleccionar variante ${i+1}" style="background-image:url('${esc(u)}')"></button>`).join('');
  return `<div class="slider"><div class="slider-track" data-i="0">${slides}</div><div class="slider-nav"><button class="slider-btn prev">‹</button><button class="slider-btn next">›</button></div><div class="thumbs-row">${thumbs}</div></div>`;
}

function bindSliderSelectable(root){
  if (!root) return;
  const track = root.querySelector('.slider-track');
  const thumbs = Array.from(root.querySelectorAll('.thumb'));
  const prevBtn = root.querySelector('.prev');
  const nextBtn = root.querySelector('.next');
  const n = Math.max(1, thumbs.length);
  let i = Number(track && track.dataset.i) || 0;
  const go = (k) => { i = ((k % n) + n) % n; if (track) track.style.transform=`translateX(-${i*100}%)`; thumbs.forEach((t,ti)=>t.classList.toggle('active',ti===i)); DETAIL_STATE.selectedImageIndex=i; };
  prevBtn && prevBtn.addEventListener('click', (e)=>{ e.stopPropagation(); go(i-1); });
  nextBtn && nextBtn.addEventListener('click', (e)=>{ e.stopPropagation(); go(i+1); });
  thumbs.forEach((t,idx)=>{
    t.addEventListener('mouseenter', ()=>{ if (track) track.style.transform=`translateX(-${idx*100}%)`; thumbs.forEach((tt,ti)=> tt.classList.toggle('preview',ti===idx)); });
    t.addEventListener('mouseleave', ()=> go(i));
    t.addEventListener('click', (e)=>{ e.stopPropagation(); go(idx); });
    t.addEventListener('focus', ()=> go(idx));
    t.onkeydown = (e)=>{ if (e.key==='Enter') t.click(); };
  });
  go(DETAIL_STATE.selectedImageIndex||0);
}

function flashSizeWarning(){
  const container = $('#detailSizes') || document.body;
  if (!container) return;
  container.classList.add('need-size');
  setTimeout(()=> container.classList.remove('need-size'), 1200);
  const first = container.querySelector('.size-btn');
  if (first) first.focus();
}

/* carrito: addCart y render */
function addCart(payload){
  if (!payload || !payload.id) return;
  const sameMatch = c => (String(c.id)===String(payload.id) && String(c.size||'')===String(payload.size||''));
  const existing = CART.find(sameMatch);
  if (existing){
    existing.qty=(existing.qty||1)+(payload.qty||1);
    existing.image=payload.image||existing.image;
    existing.price=Number(payload.price||existing.price||0);
  } else {
    CART.push({ id: payload.id, title: payload.title||'', price:Number(payload.price||0), image:payload.image||'', qty:payload.qty||1, size:payload.size||null });
  }
  localStorage.setItem('cart_v1', JSON.stringify(CART));
}

/* abrir carrito lateral (render) */
function openCart(){
  const box = $('#cartItems');
  if (!box) return;
  if (!CART.length){
    box.innerHTML='<p>No hay productos aún.</p>';
  } else {
    box.innerHTML = CART.map((it,idx)=>`
      <div class="cart-row" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <img src="${esc(it.image||'')}" alt="${esc(it.title||'')}" style="width:64px;height:84px;object-fit:cover;border-radius:8px;border:1px solid #26264a;margin-right:8px">
        <div style="flex:1">
          <div style="font-weight:600">${esc(it.title)}</div>
          <div class="muted">Talle: <b>${esc(it.size||'-')}</b></div>
          <div class="muted">$${(it.price||0).toLocaleString('es-AR')} ARS</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          <div class="muted">x${it.qty}</div>
          <button class="mini-btn" data-del="${idx}" aria-label="Quitar item">Quitar</button>
        </div>
      </div>
    `).join('');
    box.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=>{
      const idx = Number(b.dataset.del);
      CART.splice(idx,1);
      localStorage.setItem('cart_v1', JSON.stringify(CART));
      openCart();
    }));
  }
  const total = CART.reduce((a,b)=>a+(b.price||0)*(b.qty||1),0);
  const deposit = Math.round(total*0.5);
  $('#cartTotal') && ($('#cartTotal').textContent=total.toLocaleString('es-AR'));
  $('#cartDeposit') && ($('#cartDeposit').textContent=deposit.toLocaleString('es-AR'));
  $('#payLink') && ($('#payLink').onclick=handleCheckout);
  document.querySelector('.side-menu')?.classList.add('open');
  const count = CART.reduce((a,b)=>a+(b.qty||1),0);
  $('#cartCount') && ($('#cartCount').textContent=`${count} items`);
}

/* checkout */
async function handleCheckout(e){
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (!CART.length) return alert('No hay productos en el carrito.');
  const nombre = prompt("Ingrese su nombre completo:");
  if (!nombre || !nombre.trim()) return alert('Debes ingresar tu nombre.');
  const telefono = prompt("Ingrese su número de teléfono:");
  if (!telefono || !telefono.trim()) return alert('Debes ingresar tu número de teléfono.');
  const robot = confirm("Por favor confirma que NO eres un robot (Aceptar = No soy un robot)");
  if (!robot) return alert('Debes confirmar que no eres un robot.');

  const checkoutInfo = {
    nombre: nombre.trim(),
    telefono: telefono.trim(),
    items: CART,
    total: CART.reduce((a,b)=>a+(b.price||0)*(b.qty||1),0),
    ts: Date.now()
  };

  localStorage.setItem('checkoutInfo', JSON.stringify(checkoutInfo));
  try {
    // Si prefieres abrir en nueva pestaña, cambiá a window.open(...)
    window.location.href = "https://link.mercadopago.com.ar/sofymdn";
  } catch(err) {
    console.warn('redirect failed', err);
    alert('No se pudo redirigir automáticamente. Por favor, completá el pago en el enlace.');
  }
}

/* Comprobante upload renderer (se ejecuta si hay checkoutInfo y existe #comprobanteUpload) */
function renderComprobanteUpload(container, info){
  container.innerHTML = '';
  const wf = document.createElement('div');
  wf.style.maxWidth = '720px';
  wf.style.margin = '8px auto';
  wf.innerHTML = `
    <h3>Subí tu comprobante</h3>
    <p>Para terminar necesitamos que subas el comprobante aquí. Nombre: <b>${esc(info.nombre)}</b> · Tel: <b>${esc(info.telefono)}</b> · Total: <b>$${Number(info.total).toLocaleString('es-AR')}</b></p>
  `;
  const form = document.createElement('form');
  form.enctype = 'multipart/form-data';
  form.style.display = 'flex';
  form.style.flexDirection = 'column';
  form.style.gap = '8px';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,application/pdf';
  input.required = true;

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary-btn';
  submit.textContent = 'Enviar comprobante';

  const note = document.createElement('div');
  note.className = 'muted';
  note.textContent = 'El comprobante será enviado al equipo y asociado a tu pedido.';

  form.appendChild(input);
  form.appendChild(submit);
  form.appendChild(note);
  wf.appendChild(form);
  container.appendChild(wf);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.files || !input.files.length) return alert('Debes seleccionar un archivo.');
    submit.disabled = true;
    submit.textContent = 'Enviando...';

    const file = input.files[0];
    const fd = new FormData();
    // use fields that sendReceipt expects: 'receipt','name','phone','email'
    fd.append('receipt', file);
    fd.append('name', info.nombre || '');
    fd.append('phone', info.telefono || '');
    // if we don't have email, ask user quickly
    let email = info.email || '';
    if (!email) {
      email = prompt('Ingresá tu email para contacto (opcional):') || '';
    }
    fd.append('email', email);

    try {
      const res = await fetch('/.netlify/functions/sendReceipt', { method: 'POST', body: fd });
      const json = await res.json().catch(()=>({ ok:false, error:'invalid json' }));
      if (res.ok && json && json.ok) {
        alert('Comprobante enviado correctamente. ¡Gracias por tu compra!');
        localStorage.removeItem('checkoutInfo');
        CART = [];
        localStorage.setItem('cart_v1', JSON.stringify(CART));
        openCart();
        // optionally redirect to home
        window.location.href = '/';
      } else {
        throw new Error(json && json.error ? json.error : ('HTTP '+res.status));
      }
    } catch (err) {
      console.error(err);
      alert('Ocurrió un error al enviar el comprobante. Intentá nuevamente.');
      submit.disabled = false;
      submit.textContent = 'Enviar comprobante';
    }
  });
}

/* cerrar carrito */
function closeCart(){
  document.querySelector('.side-menu')?.classList.remove('open');
}

/* Binders: menu, cart button, modal closers */
function bindMenu(){
  $('#hamburger')?.addEventListener('click', ()=> $('#sideMenu')?.classList.add('open'));
  $('#closeMenu')?.addEventListener('click', ()=> $('#sideMenu')?.classList.remove('open'));
  const area = $('#menuContent');
  if (area) area.innerHTML = '';

  const contenido = {
    bienvenida: `<h3>🌷 ¡Bienvenida a Sofy mdn!</h3><p>Gracias por estar acá...</p>`,
    quienes: `<h3>💕 Quiénes somos</h3><p>Somos una empresa ...</p>`,
    revendedora: `<h3>👗 Cómo empezar a ser revendedora</h3><p>Empezar a vender...</p>`,
    faq: `<h3>🎀 Preguntas frecuentes</h3><p>Los pedidos cierran los domingos...</p>`,
    soporte: `<h3>👛 Soporte y contacto</h3><p>Estamos siempre para vos</p>`,
    unite: `<h3>✨ Unite, vendé, crecé</h3><p>¡Este es tu momento de brillar!</p>`
  };

  $$('.menu-link').forEach(b=> b.addEventListener('click', ()=>{
    const sec = b.dataset.section;
    if (area) area.innerHTML = contenido[sec] || '';
  }));
}

function bindCartButtons(){
  $('#btnCart')?.addEventListener('click', ()=> document.querySelector('.side-menu')?.classList.add('open'));
}

/* global modal closers (escape key, overlay clicks) */
function bindGlobalModalClosers(){
  document.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape') {
      // close detail
      const dm = $('#detailModal');
      try{ if (dm && typeof dm.close === 'function') dm.close(); else dm && dm.classList.remove('open'); }catch(e){}
      // close receipt modal
      const rm = $('#receiptModal');
      try{ if (rm && typeof rm.close === 'function') rm.close(); else rm && rm.classList.remove('open'); }catch(e){}
      // close side menus
      document.querySelectorAll('.side-menu.open').forEach(el=> el.classList.remove('open'));
    }
  });
}

/* cart panel close button */
function bindCartPanelClose(){
  $('#closeCartPanel')?.addEventListener('click', ()=> document.querySelector('.side-menu')?.classList.remove('open'));
}

/* -----------------------------
   Receipt modal functionality
   ----------------------------- */
function bindReceiptModal(){
  const openBtn = $('#openReceiptBtn');
  const modal = $('#receiptModal');
  const fileInput = $('#receiptFile');
  const nameInput = $('#receiptName');
  const phoneInput = $('#receiptPhone');
  const emailInput = $('#receiptEmail');
  const sendBtn = $('#receiptSendBtn');
  const cancelBtn = $('#receiptCancelBtn');
  const statusEl = $('#receiptMsg');

  // helper to show modal and focus file input
  function showReceipt() {
    try {
      if (typeof modal.showModal === 'function') modal.showModal();
      else modal.setAttribute('open','');
    } catch (e) {
      modal.setAttribute('open','');
    }
    // small timeout to allow modal to render
    setTimeout(()=>{
      try{ fileInput && fileInput.focus(); }catch(e){}
    }, 120);
  }

  // open from button
  openBtn?.addEventListener('click', (e)=> {
    e.preventDefault();
    showReceipt();
  });

  // cancel handler (redundant with markup)
  cancelBtn?.addEventListener('click', (e)=> {
    e.preventDefault();
    try{ if (typeof modal.close === 'function') modal.close(); else modal.removeAttribute('open'); }catch(e){ modal.removeAttribute('open'); }
    // clear status
    if (statusEl) { statusEl.textContent=''; statusEl.className=''; statusEl.style.color=''; }
  });

  // send handler
  sendBtn?.addEventListener('click', async (e)=>{
    e.preventDefault();
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      statusEl.textContent = 'Seleccioná un comprobante (imagen o PDF).';
      statusEl.className = 'msg-error';
      return;
    }
    const name = (nameInput && nameInput.value.trim()) || '';
    const phone = (phoneInput && phoneInput.value.trim()) || '';
    const email = (emailInput && emailInput.value.trim()) || '';

    if (!name || !phone || !email) {
      statusEl.textContent = 'Completá nombre, teléfono y email.';
      statusEl.className = 'msg-error';
      return;
    }

    // build formdata according to sendReceipt.js expectation
    const fd = new FormData();
    fd.append('receipt', fileInput.files[0]);
    fd.append('name', name);
    fd.append('phone', phone);
    fd.append('email', email);

    // UI state
    sendBtn.disabled = true;
    sendBtn.textContent = 'Enviando...';
    statusEl.textContent = 'Enviando comprobante...';
    statusEl.className = '';

    try {
      const res = await fetch('/.netlify/functions/sendReceipt', { method:'POST', body: fd });
      const json = await res.json().catch(()=>({ ok:false, error:'invalid-json' }));

      if (res.ok && json && json.ok) {
        statusEl.textContent = '✅ Comprobante enviado. Gracias — en breve te confirmaremos.';
        statusEl.className = 'msg-success';
        // clear inputs
        fileInput.value = '';
        nameInput.value = '';
        phoneInput.value = '';
        emailInput.value = '';
        // close modal shortly
        setTimeout(()=>{ try{ if (typeof modal.close === 'function') modal.close(); else modal.removeAttribute('open'); }catch(e){} }, 900);
        // optionally clear checkoutInfo and cart (if this flow is terminal)
        try {
          localStorage.removeItem('checkoutInfo');
          CART = [];
          localStorage.setItem('cart_v1', JSON.stringify(CART));
          openCart();
        }catch(e){}
      } else {
        const errTxt = (json && json.error) ? json.error : ('HTTP '+res.status);
        statusEl.textContent = 'Error: ' + errTxt;
        statusEl.className = 'msg-error';
      }
    } catch (err) {
      console.error('sendReceipt error', err);
      statusEl.textContent = 'Error enviando comprobante: ' + (err && err.message ? err.message : String(err));
      statusEl.className = 'msg-error';
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Enviar comprobante';
    }
  });

  // If redirected from Mercado Pago (or coming back with checkoutInfo), show modal automatically
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const mpSuccess = urlParams.get('mp_success');
    const ref = document.referrer || '';
    const info = JSON.parse(localStorage.getItem('checkoutInfo')||'{}');
    if ((mpSuccess === '1' || /mercadopago/i.test(ref)) && info && info.items && info.items.length) {
      // prefill name and phone from checkoutInfo if available
      if (nameInput) nameInput.value = info.nombre || '';
      if (phoneInput) phoneInput.value = info.telefono || '';
      // show modal a bit after load
      setTimeout(()=> showReceipt(), 450);
    }
  } catch(e){ /* ignore */ }
}

/* Binders: menu, cart button, modal closers */
function bindMenu(){
  $('#hamburger')?.addEventListener('click', ()=> $('#sideMenu')?.classList.add('open'));
  $('#closeMenu')?.addEventListener('click', ()=> $('#sideMenu')?.classList.remove('open'));
  const area = $('#menuContent');
  if (area) area.innerHTML = '';

  const contenido = {
    bienvenida: `<h3>🌷 ¡Bienvenida a Sofy mdn!</h3><p>Gracias por estar acá...</p>`,
    quienes: `<h3>💕 Quiénes somos</h3><p>Somos una empresa ...</p>`,
    revendedora: `<h3>👗 Cómo empezar a ser revendedora</h3><p>Empezar a vender...</p>`,
    faq: `<h3>🎀 Preguntas frecuentes</h3><p>Los pedidos cierran los domingos...</p>`,
    soporte: `<h3>👛 Soporte y contacto</h3><p>Estamos siempre para vos</p>`,
    unite: `<h3>✨ Unite, vendé, crecé</h3><p>¡Este es tu momento de brillar!</p>`
  };

  $$('.menu-link').forEach(b=> b.addEventListener('click', ()=>{
    const sec = b.dataset.section;
    if (area) area.innerHTML = contenido[sec] || '';
  }));
}

/* End of file */