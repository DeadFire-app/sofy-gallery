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
  $('#payLink').href = "https://link.mercadopago.com.ar/sofymdn"; // tu link libre real
  $('#cartModal').showModal();
}

/* menú */
function bindMenu(){
  $('#hamburger')?.addEventListener('click', ()=> $('#sideMenu').classList.add('open'));
  $('#closeMenu')?.addEventListener('click', ()=> $('#sideMenu').classList.remove('open'));
  const area = $('#menuContent');
  area.innerHTML = '';

  const contenido = {
    bienvenida: `
      <h3>🌷 ¡Bienvenida a Sofy mdn!</h3>
      <p>Gracias por estar acá. Este catálogo está pensado para que puedas <b>vender fácil y rápido</b>:
      descargá las fotos, copiá las descripciones y publicá en tus redes. Si sos revendedora nueva,
      te recomendamos pedir una <b>seña del 50%</b> a tus clientas para trabajar sin inversión inicial 💖</p>
    `,
    quienes: `
      <h3>💕 Quiénes somos</h3>
      <p>Somos una empresa dedicada a la <b>venta mayorista y minorista</b> de indumentaria, calzado y accesorios,
      con presencia en el mercado desde <b>agosto de 2016</b>.</p>
      <p>Ubicados en <b>Zárate, Buenos Aires</b>, contamos con amplia experiencia en el rubro de la moda, ofreciendo
      productos de excelente calidad y <b>fotos reales</b> que reflejan lo que nuestras clientas reciben.</p>
      <p>Nuestro proyecto nació con una visión clara: <b>brindar oportunidades reales de crecimiento</b> a mujeres y
      madres que buscan independencia económica y desean trabajar desde casa.</p>
      <p>Creemos que el <b>emprendimiento transforma</b> y que cada mujer puede alcanzar sus metas con las herramientas
      y el apoyo adecuados.</p>
      <p>En Sofy mdn fomentamos una <b>comunidad</b> de revendedoras y emprendedoras comprometidas con la confianza,
      la responsabilidad y el amor por lo que hacen 💖 Cada prenda, envío y mensaje reflejan nuestra dedicación por
      construir una marca cercana, auténtica y con propósito 🌷</p>
    `,
    revendedora: `
      <h3>👗 Cómo empezar a ser revendedora</h3>
      <p>Empezar a vender con Sofy mdn es muy fácil ✨</p>
      <ul>
        <li>📸 Descargá las <b>fotos</b> y <b>descripciones</b> desde nuestra página.</li>
        <li>💻 Copiá y publicá los productos en tus redes o tienda online.</li>
        <li>💰 Agregá tu <b>ganancia</b> al precio publicado.</li>
      </ul>
      <p>Para trabajar <b>sin inversión inicial</b>, pedí una <b>seña del 50%</b> al cliente. Así asegurás el pedido y vendés con confianza 💖</p>
      <p>Podés emprender desde tu casa, a tu ritmo, con el respaldo de nuestra marca.</p>
    `,
    faq: `
      <h3>🎀 Preguntas frecuentes</h3>
      <p><b>📅 ¿Cuándo cierran los pedidos y cuándo llegan?</b><br>
      Los pedidos cierran los <b>domingos</b> y se entregan los <b>miércoles</b>, para que organices tus ventas con anticipación ✨</p>

      <p><b>🛒 ¿Cómo realizo un pedido?</b><br>
      1️⃣ Agregá los productos al carrito.<br>
      2️⃣ Aboná el <b>50%</b> del total (seña).<br>
      3️⃣ Enviá el comprobante por WhatsApp.</p>

      <p><b>🎨 ¿Puedo elegir el color de los productos?</b><br>
      Sí, se puede agregar color opcional según disponibilidad 💖</p>

      <p><b>🔄 ¿Se pueden cambiar los productos?</b><br>
      No tienen cambio (talles exactos). Solo por <b>falla</b>, dentro de los <b>3 días</b> posteriores a la entrega.
      Las prendas <b>blancas no tienen cambio</b> bajo ninguna circunstancia 🌸</p>

      <p><b>🚚 ¿Hacen envíos?</b><br>
      Contamos con servicio de <b>mensajería en Zárate</b>, con costo según zona.</p>

      <p><b>📦 ¿Cuál es la compra mínima?</b><br>
      <b>12 artículos</b> (surtidos o iguales). Aplica a calzado e indumentaria.</p>

      <p><b>⏰ ¿Cuándo se reciben comprobantes y consultas?</b><br>
      <b>Lunes a viernes:</b> 9 a 18h<br>
      <b>Sábados y domingos:</b> 11 a 15h 💅</p>

      <p><b>💡 Tip para revendedoras:</b> Vendé desde casa sin inversión, con productos de calidad y el respaldo de nuestra marca.</p>
    `,
    soporte: `
      <h3>👛 Soporte y contacto</h3>
      <p>Estamos siempre para vos 💖 Si tenés dudas o necesitás ayuda con tu pedido, te acompañamos para que tu experiencia sea fácil y segura ✨</p>
      <p><b>Horarios de atención:</b><br>
      Lunes a viernes: 9 a 18h<br>
      Sábados y domingos: 11 a 15h</p>
      <p><b>Tip:</b> Para agilizar la respuesta, enviá tu nombre, número de pedido (si aplica) y consulta específica.</p>
      <p>Canales habilitados: próximamente publicaremos los datos de contacto.</p>
    `,
    unite: `
      <h3>✨ Unite, vendé, crecé</h3>
      <p>¡Este es tu momento de brillar! 💖</p>
      <p><b>💞 Unite:</b> Sumate a nuestra comunidad de revendedoras y accedé a productos exclusivos y precios especiales.</p>
      <p><b>🛍️ Vendé:</b> Compartí nuestros artículos de calidad en tus redes, sin inversión inicial.</p>
      <p><b>🌷 Crecé:</b> Generá ingresos, aprendé sobre ventas y emprendimiento, y formá parte de una red de mujeres que se apoyan e inspiran ✨</p>
      <p><b>Tip:</b> No hace falta experiencia previa. Solo ganas de emprender y brillar 💅</p>
    `
  };

  $$('.menu-link').forEach(b=> b.addEventListener('click', ()=>{
    const sec = b.dataset.section;
    area.innerHTML = contenido[sec] || '';
  }));
}