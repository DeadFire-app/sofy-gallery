/* helpers */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

/* CRUCIAL: Ruta base para las imágenes persistentes que sube el bot */
const IMAGE_BASE_PATH = './images/';

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
  bindReceiptModal(); // bind para modal de comprobante
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
});

/* Fix: set a real viewport height for mobile devices (if needed, although your CSS seems to handle it) */
function setRealVh() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
}


/* cargar data */
async function load(){
  try{
    // Usamos una ruta local relativa. El bot debe asegurar que un archivo data.json exista en esta ruta.
    const res = await fetch('data.json?ts=' + Date.now()); 
    if (!res.ok) throw new Error('data.json not found or failed to load.');
    const json = await res.json();
    // Tu código ya maneja la estructura de wrapper o array
    DATA = Array.isArray(json) ? { version:1, lastUpdated:new Date().toISOString(), items: json } : (json || {version:1, items:[]});
  }catch(e){
    console.error("Error al cargar data.json:", e.message);
    // Mostrar error si la galería está vacía
    if ($('#gallery')) {
      $('#gallery').innerHTML = `<p style="grid-column: 1 / -1; text-align: center; color: crimson;">ERROR: No se pudo cargar el catálogo. Detalles: ${e.message}</p>`;
    }
    DATA = { version:1, lastUpdated:"", items: [] };
  }
  render();
  finishSplash();
}

/* render principal */
function render(){
  const q = ($('#searchInput') && $('#searchInput').value || '').trim().toLowerCase();
  
  // Usamos item.material para la búsqueda
  const items = (DATA.items || []).filter(x=>{
    if (x.deleted) return false;
    if (!q) return true;
    // Se incluye caption (antes title), material y tags en el blob de búsqueda
    const blob = [x.caption, x.description, x.material, ...(x.tags||[])].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(p => blob.includes(p));
  });

  $('#countInfo') && ($('#countInfo').textContent = `${items.length} artículos`);
  const totalPages = Math.max(1, Math.ceil(items.length / VIEW.pageSize));
  if (VIEW.page > totalPages) VIEW.page = totalPages;
  const start = (VIEW.page-1) * VIEW.pageSize;
  const pageItems = items.slice(start, start + VIEW.pageSize);
  $('#gallery').innerHTML = pageItems.map(cardHTML).join('');
  renderPagination(totalPages);
}

/* tarjetas (ACTUALIZADO para usar imageName y material) */
function cardHTML(item){
  // CRUCIAL: Usamos item.imageName para la URL de la imagen principal
  const coverUrl = item.imageName ? IMAGE_BASE_PATH + esc(item.imageName) : '';
  const title = item.caption || `Producto ID: ${item.id}`;
  const price = item.price ? `$${Number(item.price).toLocaleString('es-AR')} ARS` : '$Precio N/A';
  
  // Tags: Incluimos material primero, luego otros tags
  const materialTag = item.material ? `<span class="tag">${esc(item.material)}</span>` : '';
  const otherTags = (item.tags||[]).slice(0,2).map(t=>`<span class="tag">${esc(t)}</span>`).join('');
  const allTags = materialTag + otherTags;

  if (!coverUrl) return ''; // No renderizar si no hay imagenName

  return `
    <article class="card" data-id="${esc(item.id)}" tabindex="0" aria-labelledby="title-${esc(item.id)}">
      <div class="dl-wrap">
        <button class="dl-btn" data-url="${coverUrl}" data-name="${esc(item.imageName || 'imagen.jpg')}" title="Descargar" aria-label="Descargar imagen">
          <svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM7 10h4V4h2v6h4l-5 5-5-5z"/></svg>
        </button>
        <img class="card-img" loading="lazy" src="${coverUrl}" alt="${esc(title)}"/>
      </div>
      <div class="card-body">
        <h3 class="card-title truncate-2" id="title-${esc(item.id)}">${esc(title)}</h3>
        <p class="card-desc">${price}</p>
        <div class="tags">${allTags}</div>
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
    // Usamos DATA.items para la búsqueda, ya que load() guarda ahí la data
    const item = (DATA.items || []).find(x => String(x.id) === String(id));
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

/* Detalle: slider + thumbs + multiple talles (ACTUALIZADO para usar albumImages y caption) */
function openDetail(item){
  if (!item) return;
  DETAIL_STATE.currentItem = item;
  DETAIL_STATE.selectedImageIndex = 0;
  DETAIL_STATE.selectedSizes = new Set();
  
  // CRUCIAL: Usamos item.caption para el título
  $('#detailTitle') && ($('#detailTitle').textContent = item.caption || '');
  $('#detailDesc') && ($('#detailDesc').textContent = item.description || '');
  
  // Tags: Incluimos material primero, luego otros tags
  const materialTag = item.material ? `<span class="tag">${esc(item.material)}</span>` : '';
  const otherTags = (item.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('');
  $('#detailTags') && ($('#detailTags').innerHTML = materialTag + otherTags);

  // CRUCIAL: Construir la lista de URLs de las imágenes
  let imageNames = [];
  if (item.imageName) {
      imageNames.push(item.imageName);
  }
  if (Array.isArray(item.albumImages)) {
      imageNames = imageNames.concat(item.albumImages);
  }
  // Convertir nombres a URLs únicas y absolutas
  const albumUrls = Array.from(new Set(imageNames)).filter(name => name)
                         .map(name => IMAGE_BASE_PATH + esc(name));

  $('#detailImages') && ($('#detailImages').innerHTML = sliderWithThumbsHTML(albumUrls));
  
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
    
    // Obtener la URL de la imagen seleccionada para el carrito
    const selectedImgUrl = albumUrls[DETAIL_STATE.selectedImageIndex] || albumUrls[0] || '';

    sizesSelectedArray.forEach(sz => {
      addCart({ 
        id: item.id, 
        title: item.caption || item.id, // Usamos item.caption
        price: Number(item.price||0), 
        image: selectedImgUrl, // Usamos la URL completa
        qty: 1, 
        size: sz 
      });
    });
    
    DETAIL_STATE.selectedSizes.clear();
    const dlg = $('#detailModal');
    try { dlg.close(); } catch(e){ dlg.classList.remove('open'); }
    openCart();
  };
  
  const dlg = $('#detailModal');
  if (dlg) { 
    if (typeof dlg.showModal==='function'){ try{ dlg.showModal(); } catch(e){ dlg.classList.add('open'); } } 
    else { dlg.classList.add('open'); } 
  }
}

function sliderWithThumbsHTML(arr){
  const slides = arr.map((u,i)=>`<div class="slide" data-i="${i}" style="flex:0 0 100%"><img loading="lazy" src="${u}" alt="foto ${i+1}"/></div>`).join('');
  const thumbs = arr.map((u,i)=>`<button class="thumb" data-i="${i}" aria-label="Seleccionar variante ${i+1}" style="background-image:url('${u}')"></button>`).join('');
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
  
  const go = (k) => { 
    i = ((k % n) + n) % n; 
    if (track) track.style.transform=`translateX(-${i*100}%)`; 
    thumbs.forEach((t,ti)=>t.classList.toggle('active',ti===i)); 
    DETAIL_STATE.selectedImageIndex=i; 
    
    // Ajuste de accesibilidad: actualizar aria-current
    thumbs.forEach((t, ti) => t.setAttribute('aria-current', ti === i ? 'true' : 'false'));
  };

  prevBtn && prevBtn.addEventListener('click', (e)=>{ e.stopPropagation(); go(i-1); });
  nextBtn && nextBtn.addEventListener('click', (e)=>{ e.stopPropagation(); go(i+1); });
  
  thumbs.forEach((t,idx)=>{
    // Limpiamos los eventos de preview para evitar errores en móviles/accesibilidad
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
  $('#cartCount') && ($('#cartCount').textContent=`${count} artículos`);
}

/* checkout */
async function handleCheckout(e){
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (!CART.length) { 
    // Usamos modal custom en lugar de alert
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `<p>⚠️ No hay productos en el carrito. Agregá algo antes de pagar.</p><button onclick="this.closest('dialog').close()">Cerrar</button>`;
    document.body.appendChild(dialog);
    try { dialog.showModal(); } catch(e){ console.error(e); }
    return;
  }
  
  // Usamos custom modal para pedir nombre y teléfono, ya que alert/prompt no son permitidos
  const modalHTML = `
    <dialog id="checkoutModal" class="info-modal" aria-modal="true" aria-label="Confirmación de pedido">
      <div class="detail-body" style="max-width:400px;text-align:center;">
        <h3 style="margin-top:0">Confirmación de pedido</h3>
        <p>Para generar el link de pago, necesitamos tus datos de contacto.</p>
        <form id="checkoutForm" style="display:flex;flex-direction:column;gap:10px;">
          <input id="checkoutName" type="text" placeholder="Nombre completo" required style="padding:10px;border-radius:8px;border:1px solid var(--muted-border);background:var(--bg-card);color:var(--text)">
          <input id="checkoutPhone" type="text" placeholder="Teléfono (ej: 1123456789)" required style="padding:10px;border-radius:8px;border:1px solid var(--muted-border);background:var(--bg-card);color:var(--text)">
          <div id="checkoutMsg" style="color:red;min-height:1.2em;"></div>
          <button type="submit" class="primary-btn" id="confirmCheckoutBtn" style="margin-top:10px;">Continuar a Mercado Pago</button>
        </form>
      </div>
    </dialog>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  const checkoutModal = $('#checkoutModal');
  const checkoutForm = $('#checkoutForm');
  const checkoutMsg = $('#checkoutMsg');
  const confirmCheckoutBtn = $('#confirmCheckoutBtn');

  if (typeof checkoutModal.showModal==='function'){ try{ checkoutModal.showModal(); } catch(e){ checkoutModal.classList.add('open'); } } 
  else { checkoutModal.classList.add('open'); }

  checkoutForm.onsubmit = async (e) => {
    e.preventDefault();
    const nombre = $('#checkoutName').value.trim();
    const telefono = $('#checkoutPhone').value.trim();

    if (!nombre || !telefono) {
      checkoutMsg.textContent = 'Por favor, completá todos los campos.';
      return;
    }
    
    // Validación robot (simplificada con un checkbox en un entorno real)
    confirmCheckoutBtn.disabled = true;
    confirmCheckoutBtn.textContent = 'Procesando...';
    
    const checkoutInfo = {
      nombre: nombre,
      telefono: telefono,
      items: CART,
      total: CART.reduce((a,b)=>a+(b.price||0)*(b.qty||1),0),
      ts: Date.now()
    };

    localStorage.setItem('checkoutInfo', JSON.stringify(checkoutInfo));
    
    // Cierre del modal antes de redirigir
    try { checkoutModal.close(); } catch(e){ checkoutModal.classList.remove('open'); }
    checkoutModal.remove();

    try {
      // Redirección a link de Mercado Pago
      window.location.href = "https://link.mercadopago.com.ar/sofymdn"; 
    } catch(err) {
      console.warn('redirect failed', err);
      // Fallback
      alert('No se pudo redirigir automáticamente. Por favor, completá el pago en el enlace.');
    }
  };
}

/* Comprobante upload renderer (se ejecuta si hay checkoutInfo y existe #comprobanteUpload) */
// Función original (no requiere cambios si ya estaba vinculada al botón en el HTML)
function bindReceiptModal(){
  const receiptForm = $('#receiptForm');
  const receiptSendBtn = $('#receiptSendBtn');
  const receiptMsg = $('#receiptMsg');

  if (!receiptForm || !receiptSendBtn) return;

  receiptSendBtn.addEventListener('click', async (e) => {
    // La lógica de simulación de envío ya estaba en el index.html, 
    // por lo que no la duplicamos aquí, confiando en el código del index. 
    // Pero si estuviera solo en app.js, aquí iría la lógica de validación y simulación/envío.
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
    bienvenida: `<h3>🌷 ¡Bienvenida a Sofy mdn!</h3><p>Gracias por estar acá y sumarte a nuestro equipo. <br>Aquí encontrarás todo lo que necesitás para empezar a vender nuestras colecciones exclusivas.</p>`,
    quienes: `<h3>💕 Quiénes somos</h3><p>Somos una marca dedicada a ofrecer indumentaria de moda con foco en la calidad de las telas y diseños únicos. Nacimos de la pasión por la reventa y el crecimiento mutuo.</p>`,
    revendedora: `<h3>👗 Cómo empezar a ser revendedora</h3><p>1. <b>Registrate</b> con nuestro equipo de soporte.<br>2. <b>Hacé tu primer pedido</b> mínimo (seña del 50%).<br>3. <b>¡Empezá a vender!</b> Utilizá este catálogo y nuestros recursos gráficos.</p>`,
    faq: `<h3>🎀 Preguntas frecuentes</h3><p><b>¿Cuándo cierran los pedidos?</b> Los pedidos cierran los domingos a las 20hs.<br><b>¿Cuánto tarda la entrega?</b> Una vez cerrada la orden, la entrega se realiza entre 5 y 7 días hábiles.</p>`,
    soporte: `<h3>👛 Soporte y contacto</h3><p>Podés contactarnos por WhatsApp o a través de nuestro email de soporte. ¡Estamos siempre para vos!</p>`,
    unite: `<h3>✨ Unite, vendé, crecé</h3><p>¡Este es tu momento de brillar! Al unirte a Sofy mdn, accedes a precios mayoristas exclusivos y soporte constante para tu negocio.</p>`
  };

  $$('.menu-link').forEach(b=> b.addEventListener('click', ()=>{
    const sec = b.dataset.section;
    if (area) area.innerHTML = contenido[sec] || '';
  }));
}

function bindCartButtons(){
  $('#btnCart')?.addEventListener('click', openCart);
}

function bindCartPanelClose(){
  $('#closeCartPanel')?.addEventListener('click', closeCart);
}

function bindGlobalModalClosers(){
  // Manejo de clicks fuera de los modales para cerrarlos
  const detailModal = $('#detailModal');
  const receiptModal = $('#receiptModal');
  
  if (detailModal) {
    detailModal.addEventListener('click', (e) => {
      if (e.target.nodeName === 'DIALOG') {
        try { detailModal.close(); } catch(err){ detailModal.classList.remove('open'); }
      }
    });
  }

  if (receiptModal) {
    receiptModal.addEventListener('click', (e) => {
      if (e.target.nodeName === 'DIALOG') {
        try { receiptModal.close(); } catch(err){ receiptModal.classList.remove('open'); }
      }
    });
  }
}

/* End of file */