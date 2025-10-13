/* helpers */
const $ = s=>document.querySelector(s);
const $$ = s=>Array.from(document.querySelectorAll(s));
const esc = s=>String(s||'').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

/* state */
let DATA = { version:1, lastUpdated:"", items: [] };
let VIEW = { page:1, pageSize:10 };
let CART = JSON.parse(localStorage.getItem('cart_v1')||'[]');

/* Splash: dejamos en escena ~2.3s + 0.9s de salida */
function finishSplash(){
  setTimeout(()=>{
    const el = $('#splash');
    if (!el) return;
    el.classList.add('hide');
    setTimeout(()=> el.remove(), 900);
  }, 2300);
}

document.addEventListener('DOMContentLoaded', ()=>{
  $('#year').textContent = new Date().getFullYear();
  bindMenu();
  bindCart();
  bindSearch();
  load();
  setRealVh();           // fix viewport móvil
  addEventListener('resize', setRealVh);
  addEventListener('orientationchange', setRealVh);
});

/* cargar data */
async function load(){
  try{
    const res = await fetch('data.json?ts='+Date.now());
    const json = await res.json();
    DATA = Array.isArray(json)
      ? { version:1, lastUpdated:new Date().toISOString(), items: json }
      : (json||{version:1,items:[]});
  }catch(_){
    DATA = { version:1, lastUpdated:"", items: [] };
  }
  render();
  finishSplash();
}

/* render principal */
function render(){
  const q = $('#searchInput').value.trim().toLowerCase();
  const items = (DATA.items||[]).filter(x=>{
    if (x.deleted) return false;
    if (!q) return true;
    const blob = [x.title, x.description, ...(x.tags||[])].join(' ').toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(p=> blob.includes(p));
  });

  $('#countInfo').textContent = `${items.length} items`;

  const totalPages = Math.max(1, Math.ceil(items.length / VIEW.pageSize));
  if (VIEW.page > totalPages) VIEW.page = totalPages;

  const start = (VIEW.page-1)*VIEW.pageSize;
  const pageItems = items.slice(start, start+VIEW.pageSize);

  $('#gallery').innerHTML = pageItems.map(cardHTML).join('');
  bindCards($('#gallery'));
  bindDownloadButtons($('#gallery'));
  renderPagination(totalPages);
}

/* tarjetas */
function cardHTML(item){
  const imgs = Array.isArray(item.images)&&item.images.length ? item.images : (item.image?[item.image]:[]);
  const cover = esc(imgs[0]||'');
  const fileBase = (item.title || 'imagen').toLowerCase().replace(/[^\w\-]+/g, '-').slice(0,50);
  const tags = (item.tags||[]).slice(0,3).map(t=>`<span class="tag">${esc(t)}</span>`).join('');

  return `
    <article class="card" data-id="${esc(item.id)}">
      <div class="dl-wrap">
        <button class="dl-btn" data-url="${cover}" data-name="${fileBase}.jpg" title="Descargar">
          <svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM7 10h4V4h2v6h4l-5 5-5-5z"/></svg>
        </button>
        <img class="card-img" loading="lazy" src="${cover}" alt="${esc(item.title)}"/>
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(item.title)}</h3>
        <p class="card-desc">${esc(item.description)}</p>
        <div class="tags">${tags}</div>
        <div class="card-cta">
          <button class="mini-btn btn-more">Ver detalle</button>
          <button class="mini-btn btn-add">Agregar</button>
        </div>
      </div>
    </article>
  `;
}

function bindCards(root){
  root.querySelectorAll('.card').forEach(card=>{
    const id = card.dataset.id;
    const item = (DATA.items||[]).find(x=>String(x.id)===String(id));
    card.querySelector('.btn-more')?.addEventListener('click', e=>{
      e.stopPropagation(); openDetail(item);
    });
    card.querySelector('.btn-add')?.addEventListener('click', e=>{
      e.stopPropagation(); addCart(item);
    });
    card.addEventListener('click', ()=> openDetail(item));
  });
}

/* paginación */
function renderPagination(total){
  const pag = $('#pagination');
  const cells = [];
  const max = Math.min(total, 10);
  for (let i=1;i<=max;i++){
    cells.push(`<button class="page-btn ${i===VIEW.page?'active':''}" data-p="${i}">${i}</button>`);
  }
  pag.innerHTML = cells.length? cells.join('') : '';
  pag.querySelectorAll('.page-btn').forEach(b=> b.addEventListener('click', ()=>{
    VIEW.page = Number(b.dataset.p); render();
  }));
}

/* búsqueda */
function bindSearch(){
  $('#searchInput')?.addEventListener('input', ()=>{
    VIEW.page = 1; render();
  });
}

/* detalle modal + slider */
function openDetail(item){
  const dlg = $('#detailModal');
  $('#detailTitle').textContent = item.title||'';
  $('#detailDesc').textContent = item.description||'';
  $('#detailTags').innerHTML = (item.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('');

  const imgs = Array.isArray(item.images)&&item.images.length ? item.images : (item.image?[item.image]:[]);
  $('#detailImages').innerHTML = sliderHTML(imgs);
  bindSlider($('#detailImages'));

  $('#addToCart').onclick = ()=> addCart(item);
  dlg.showModal();
}
$$('.modal-x').forEach(x=> x.addEventListener('click', e=>{
  const t = e.currentTarget.dataset.close;
  if (t==='detail') $('#detailModal').close();
  if (t==='cart') $('#cartModal').close();
}));

function sliderHTML(arr){
  const slides = arr.map(u=>`<div style="flex:0 0 100%"><img loading="lazy" src="${esc(u)}" alt="foto"/></div>`).join('');
  const dots = arr.map((_,i)=>`<span class="slider-dot ${i===0?'active':''}" data-i="${i}"></span>`).join('');
  return `
    <div class="slider-track" data-i="0">${slides}</div>
    <div class="slider-nav">
      <button class="slider-btn prev">‹</button>
      <button class="slider-btn next">›</button>
    </div>
    <div class="slider-dots">${dots}</div>
  `;
}
function bindSlider(root){
  const track = root.querySelector('.slider-track');
  const dots = root.querySelectorAll('.slider-dot');
  const n = dots.length||1;
  let i = 0;
  const go = (k)=>{ i = (k+n)%n; track.style.transform = `translateX(-${i*100}%)`; dots.forEach((d,di)=>d.classList.toggle('active',di===i)); };
  root.querySelector('.prev')?.addEventListener('click', ()=> go(i-1));
  root.querySelector('.next')?.addEventListener('click', ()=> go(i+1));
  dots.forEach(d=> d.addEventListener('click', ()=> go(Number(d.dataset.i))));
}

/* descarga */
function bindDownloadButtons(root){
  root.querySelectorAll('.dl-btn').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const url = btn.dataset.url;
      const name = btn.dataset.name || 'imagen.jpg';
      try{
        const res = await fetch(url, { mode:'cors' });
        if (!res.ok) throw 0;
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        triggerDownload(href, name);
        setTimeout(()=>URL.revokeObjectURL(href), 4000);
      }catch{
        window.open(url, '_blank', 'noopener');
      }
    });
  });
}
function triggerDownload(href, filename){
  const a = document.createElement('a'); a.href = href; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
}

/* carrito */
function bindCart(){ $('#btnCart')?.addEventListener('click', openCart); }
function addCart(item){
  CART.push({ id:item.id, title:item.title, price:item.price||0, image:(item.image||''), qty:1 });
  localStorage.setItem('cart_v1', JSON.stringify(CART));
  openCart();
}
function openCart(){
  const box = $('#cartItems');
  if (!CART.length){ box.innerHTML = '<p>No hay productos aún.</p>'; }
  else{
    box.innerHTML = CART.map((it,idx)=>`
      <div class="cart-row" style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <img src="${esc(it.image||'')}" alt="" style="width:54px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #26264a;margin-right:8px">
        <div style="flex:1">
          <div>${esc(it.title)}</div>
          <div class="muted">$${(it.price||0).toLocaleString('es-AR')} ARS</div>
        </div>
        <button class="mini-btn" data-del="${idx}">Quitar</button>
      </div>
    `).join('');
    box.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=>{
      const idx = Number(b.dataset.del); CART.splice(idx,1);
      localStorage.setItem('cart_v1', JSON.stringify(CART)); openCart();
    }));
  }
  const total = CART.reduce((a,b)=> a+(b.price||0)*(b.qty||1), 0);
  const deposit = Math.round(total * 0.5);
  $('#cartTotal').textContent = total.toLocaleString('es-AR');
  $('#cartDeposit').textContent = deposit.toLocaleString('es-AR');
  $('#payLink').href = "https://www.mercadopago.com.ar/checkout/v1/redirect?preference-id=LINK_LIBRE"; // tu link libre real
  $('#cartModal').showModal();
}

/* menú */
function bindMenu(){
  $('#hamburger')?.addEventListener('click', ()=> $('#sideMenu').classList.add('open'));
  $('#closeMenu')?.addEventListener('click', ()=> $('#sideMenu').classList.remove('open'));
  $('#menuContent').innerHTML = '';
  $$('.menu-link').forEach(b=> b.addEventListener('click', ()=>{
    const sec = b.dataset.section;
    const area = $('#menuContent');
    if (sec==='contacto' || sec==='soporte') { window.location.href = "https://wa.me/5493487231547"; return; }
    if (sec==='pagos'){
      area.innerHTML = `
        <h3>Cómo pagar</h3>
        <p>Agregá productos al carrito y aboná una <b>seña del 50%</b> del total. Luego enviá el comprobante por WhatsApp para confirmar tu pedido.</p>
      `;
    } else if (sec==='revendedora'){
      area.innerHTML = `
        <h3>¿Querés ser revendedora?</h3>
        <p>Empezar a vender con Sofy mdn es muy fácil ✨

📸 Descargá las fotos y descripciones desde nuestra página.
💻 Copiá y publicá los productos en tus redes o tienda online.
💰 Agregá tu ganancia al precio publicado.

Para trabajar sin inversión inicial, te recomendamos solicitar una seña del 50% al cliente.
Así asegurás el pedido y vendés con total confianza 💖

Con este método podés comenzar a emprender desde tu casa, a tu ritmo y con el respaldo de una marca que te acompaña</p>
      `;
    } else if (sec==='info'){
      area.innerHTML = `
        <h3>Información</h3>
        <p>Este es un <b>catálogo virtual</b> para compra y gestión de stock. Las imágenes pueden variar según disponibilidad de color/talle.</p>
      `;
    }
  }));
}

/* ===== Fix de viewport móvil (barra de direcciones) ===== */
function setRealVh(){
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}