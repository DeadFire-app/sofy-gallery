// netlify/functions/tgWebhook.js
// Webhook reforzado para Telegram (Sofy) - Netlify
// - Responde 200 siempre (Telegram no se enoja).
// - Manejo álbumes, fotos, subida a repo (github.js), create via ADD_URL, update data.json UNA VEZ.
// - Locks por usuario, timeouts, retries, notificaciones ADMIN_CHAT_ID.
// - Requiere ./github.js con uploadFileToRepo/getDataJSON/putDataJSON/deleteFileFromRepo
'use strict';

/* ENV REQUIRED:
BOT_TOKEN
API_KEY
ADD_URL
DELETE_URL
ADMIN_CHAT_ID
*/

const { uploadFileToRepo, getDataJSON, putDataJSON, deleteFileFromRepo } = require('./github.js');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const API_KEY = process.env.API_KEY || '';
const ADD_URL = process.env.ADD_URL || '';
const DELETE_URL = process.env.DELETE_URL || '';
const ADMIN = process.env.ADMIN_CHAT_ID || '';

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const TG_FILE = BOT_TOKEN ? `https://api.telegram.org/file/bot${BOT_TOKEN}` : null;

if (!BOT_TOKEN) console.warn('[tgWebhook] WARNING: BOT_TOKEN not set');
if (!API_KEY) console.warn('[tgWebhook] WARNING: API_KEY not set');
if (!ADD_URL) console.warn('[tgWebhook] WARNING: ADD_URL not set');
if (!DELETE_URL) console.warn('[tgWebhook] WARNING: DELETE_URL not set');
if (!ADMIN) console.warn('[tgWebhook] WARNING: ADMIN_CHAT_ID not set');

// config
const DEFAULT_TIMEOUT = 15000; // ms
const NETWORK_RETRIES = 2;
const IMAGE_BATCH_DELETE = 6;

// catalogs (kept short for brevity, you can expand)
const FABRICS = [ 'algodón','lino','viscosa','modal','jean','saten','poliéster','rayón','algodon rustico' ];
const SIZES = [ '1 ( S )','2 ( M )','3 ( L )','4 ( XL )','5 ( XXL )','unico','36','38','40','42' ];

// in-memory sessions & locks (note: serverless may cold start)
const SESSIONS = new Map();
const USER_LOCKS = new Set();
function session(chatId){
  let s = SESSIONS.get(chatId);
  if(!s){
    s = { step:null, data:{}, images:[], albumId:null, selectedSizes:new Set(), processing:false, lastMsgId:null };
    SESSIONS.set(chatId, s);
  }
  return s;
}
function resetSession(chatId){ SESSIONS.delete(chatId); }

async function acquireLock(chatId, timeout = 3000){
  const start = Date.now();
  while(true){
    if(!USER_LOCKS.has(chatId)){ USER_LOCKS.add(chatId); return true; }
    if(Date.now() - start > timeout) return false;
    await new Promise(r=>setTimeout(r,50));
  }
}
function releaseLock(chatId){ USER_LOCKS.delete(chatId); }

// network helpers
async function fetchTimeout(url, opts = {}, timeout = DEFAULT_TIMEOUT){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), timeout);
  try{
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  }finally{ clearTimeout(id); }
}
async function safeFetch(url, opts = {}, retries = NETWORK_RETRIES){
  let last;
  for(let i=0;i<=retries;i++){
    try{ return await fetchTimeout(url, opts); }
    catch(err){ last = err; await new Promise(r=>setTimeout(r, 120 * Math.pow(2,i))); }
  }
  throw last;
}
async function safeJson(res){
  try{ return await res.json(); }catch(e){ return null; }
}
function sanitize(s){ if(!s) return ''; return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,500); }
function normalizeFilename(name='item'){ return name.toString().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_').replace(/[^a-z0-9_\-\.]/g,'').slice(0,180); }

// Telegram helpers
async function tgCall(method, payload={}, retries = NETWORK_RETRIES){
  if(!TG_API) throw new Error('BOT_TOKEN missing');
  const url = `${TG_API}/${method}`;
  let last;
  for(let i=0;i<=retries;i++){
    try{
      const res = await safeFetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      const j = await safeJson(res) || {};
      if(!j.ok) throw new Error(`tg ${method} error: ${res.status} ${JSON.stringify(j)}`);
      return j;
    }catch(err){ last = err; await new Promise(r=>setTimeout(r, 100 * Math.pow(2,i))); }
  }
  throw last;
}
async function tgSend(chat_id, text, extras = {}){ try{ return await tgCall('sendMessage', { chat_id, text, ...extras }); }catch(e){ console.warn('[tgSend] ', e.message); } }
async function tgAnswerCallback(id, text=''){ try{ await tgCall('answerCallbackQuery', { callback_query_id:id, text }); }catch(e){} }
async function getFileUrl(file_id){ const r = await tgCall('getFile', { file_id }); const path = r.result && r.result.file_path; if(!path) throw new Error('getFile: no file_path'); return `${TG_FILE}/${path}`; }
async function notifyAdmin(msg){ if(!ADMIN) return; try{ await tgSend(ADMIN, `⚠️ ${msg}`, { parse_mode:'HTML' }); }catch(e){ console.warn('[notifyAdmin]', e.message); } }

// keyboards
function fabricKeyboard(page=0){ const perPage=12, perRow=2, start=page*perPage; const slice=FABRICS.slice(start,start+perPage); const rows=[]; for(let i=0;i<slice.length;i+=perRow) rows.push(slice.slice(i,i+perRow).map(f=>({ text:f, callback_data:`fab|${f}` }))); const nav=[]; if(start>0) nav.push({ text:'«', callback_data:`fabpage|${page-1}` }); if(start+perPage<FABRICS.length) nav.push({ text:'»', callback_data:`fabpage|${page+1}` }); if(nav.length) rows.push(nav); return { inline_keyboard: rows }; }
function sizesKeyboard(selected=new Set()){ const perRow=4, rows=[]; for(let i=0;i<SIZES.length;i+=perRow){ rows.push(SIZES.slice(i,i+perRow).map(sz=>({ text: selected.has(sz) ? `✅ ${sz}` : sz, callback_data:`size|${sz}` }))); } rows.push([{ text:'Continuar ▶', callback_data:'sizes_done' }]); return { inline_keyboard: rows }; }
function yesNoKeyboard(key){ return { inline_keyboard: [[{ text:'Sí', callback_data:`yes|${key}` },{ text:'No', callback_data:`no|${key}` }]] }; }

// product helpers
function productDescription({ fabric, sizes, price }){
  const talla = Array.from(sizes||[]).join(', ');
  const ftxt = fabric ? (fabric[0].toUpperCase()+fabric.slice(1)) : '—';
  const p = (Number(price)||0).toLocaleString('es-AR');
  return `Tela: ${ftxt} · Talles: ${talla||'—'} · Precio: $${p} ARS`;
}
function productTags({ fabric, sizes }){
  const s = Array.from(sizes||[]);
  return [...(fabric?[fabric.toLowerCase()]:[]), ...s.map(x=>x.toLowerCase())];
}

// core features: create product + update data.json once
async function createProduct({ title, description, images, tags, price }){
  if(!ADD_URL) throw new Error('ADD_URL missing');
  const body = { title, description, images, tags, price };
  const res = await safeFetch(ADD_URL, { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key': API_KEY }, body: JSON.stringify(body) }, NETWORK_RETRIES);
  const j = await safeJson(res);
  if(!res.ok) throw new Error(j && j.error ? j.error : `HTTP ${res.status}`);
  return j;
}
async function appendToDataJson(newItem){
  const pj = await getDataJSON();
  const items = pj.items || [];
  const sha = pj.sha;
  items.push(newItem);
  await putDataJSON({ items, sha, message: `add via bot id:${newItem.id||'bot_'+Date.now()}` });
}

// Handlers
async function handleStart(chatId){
  const txt = 'Hola 👋 Soy el bot de catálogo Sofy.\nEnviame una foto (o un álbum) y te ayudo a cargarla.\nFlujo: foto → nombre → tela → talles → precio → /listo';
  await tgSend(chatId, txt);
}

async function handleReset(chatId){
  try{
    const pj = await getDataJSON();
    const items = pj.items || [];
    const sha = pj.sha;
    const allImgs = [];
    for(const it of items) if(it.images) allImgs.push(...it.images);
    for(let i=0;i<allImgs.length;i+=IMAGE_BATCH_DELETE){
      const batch = allImgs.slice(i,i+IMAGE_BATCH_DELETE).map(n=> deleteFileFromRepo(`images/${n}`).catch(()=>{}));
      await Promise.all(batch);
    }
    await putDataJSON({ items: [], sha, message: 'reset via bot' });
    await tgSend(chatId, '✅ RESET completo: se borraron productos e imágenes.');
  }catch(err){
    await tgSend(chatId, `❌ Error en RESET: ${sanitize(err.message)}`);
    await notifyAdmin(`RESET fail: ${err.message}`);
  }
}

async function handlePhoto(msg){
  const chatId = msg.chat && msg.chat.id;
  if(!chatId) return;
  const lock = await acquireLock(chatId);
  if(!lock){ await tgSend(chatId, 'Servidor ocupado. Reintentá en un momento.'); return; }
  try{
    const s = session(chatId);
    const photo = (msg.photo||[]).slice(-1)[0];
    const doc = (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image')) ? msg.document : null;
    const fileObj = photo || doc;
    if(!fileObj){ await tgSend(chatId, 'No identifiqué la imagen. Mandá como foto o documento de imagen.'); return; }

    // filename
    const base = normalizeFilename(s.data.title || `item_${chatId}`) + '_' + Date.now();
    const idx = (s.images.length || 0) + 1;
    const fname = `${base}_${idx}.jpg`;

    // get file url from telegram
    let url;
    try{ url = await getFileUrl(fileObj.file_id); }catch(err){ await notifyAdmin(`getFile fail: ${err.message}`); await tgSend(chatId, 'Error obteniendo imagen.'); return; }

    // upload
    try{ await uploadFileToRepo(url, fname); s.images.push(fname); }catch(err){ await notifyAdmin(`uploadFile fail ${fname}: ${err.message}`); await tgSend(chatId, 'Error subiendo imagen al repo.'); return; }

    const mgid = msg.media_group_id || null;
    if(mgid){
      if(!s.albumId || s.albumId !== mgid){
        s.albumId = mgid; s.selectedSizes = new Set(); s.step = 'album_confirm';
        await tgSend(chatId, '📸 Detecté un álbum. ¿Todas las fotos son de la misma prenda?', { reply_markup: yesNoKeyboard('same_item') });
      } else {
        // silent add
      }
    } else {
      s.albumId = null; s.selectedSizes = new Set(); s.step = s.step || 'ask_title';
      if(s.step === 'ask_title') await tgSend(chatId, '📝 Decime el nombre de la prenda.');
      else await tgSend(chatId, 'Imagen recibida. Podés enviar más o escribir el nombre.');
    }

  }finally{ releaseLock(chatId); }
}

async function handleCallback(query){
  const id = query.id;
  const msg = query.message;
  const chatId = msg && msg.chat && msg.chat.id;
  if(!chatId){ try{ await tgAnswerCallback(id,'Error interno'); }catch(e){} return; }
  const s = session(chatId);
  const data = query.data || '';
  try{
    if(data.startsWith('fabpage|')){ const page = Number(data.split('|')[1]||'0')||0; await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: fabricKeyboard(page) }); return; }
    if(data.startsWith('fab|')){ const fab = data.split('|')[1]; s.data.fabric = fab; s.step = 'sizes'; await tgCall('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: `Tela seleccionada: <b>${fab}</b>`, parse_mode:'HTML' }); await tgSend(chatId, 'Elegí los talles:', { parse_mode:'HTML', reply_markup: sizesKeyboard(s.selectedSizes) }); return; }
    if(data.startsWith('size|')){ const sz = data.split('|')[1]; if(!sz) return; if(s.selectedSizes.has(sz)) s.selectedSizes.delete(sz); else s.selectedSizes.add(sz); await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: sizesKeyboard(s.selectedSizes) }); return; }
    if(data === 'sizes_done'){ s.data.sizes = new Set(Array.from(s.selectedSizes)); s.step = 'price'; await tgSend(chatId, '💵 Ingresá el precio en ARS (solo números).'); return; }
    if(data.startsWith('yes|') || data.startsWith('no|')){ const key = data.split('|')[1]; if(key === 'same_item'){ if(data.startsWith('yes|')){ s.step = 'ask_title'; await tgSend(chatId, '📝 Decime el nombre de la prenda.'); } else { s.images = []; s.albumId = null; s.step = null; await tgSend(chatId, 'Ok — cada foto será tratada por separado. Enviá nombre para la primera foto.'); } } await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(()=>{}); return; }
  }catch(err){ await notifyAdmin(`callback error: ${err.message}`); } finally { try{ await tgAnswerCallback(id); }catch(e){} }
}

async function handleText(msg){
  const chatId = msg.chat && msg.chat.id;
  if(!chatId) return;
  const text = (msg.text || '').trim();
  const s = session(chatId);

  if(text === '/start') return handleStart(chatId);
  if(text === '/reset') return handleReset(chatId);

  // /eliminar
  if(text.startsWith('/eliminar')){
    let id = null;
    const rep = msg.reply_to_message && msg.reply_to_message.text;
    if(rep){ const m = rep.match(/\[ID:\s*([^\]]+)\]/); if(m) id = m[1]; }
    if(!id){ const m2 = text.match(/\/eliminar\s+([^\s]+)/); if(m2) id = m2[1]; }
    if(!id){ await tgSend(chatId, 'Para eliminar: respondé al mensaje de confirmación con /eliminar o usa /eliminar <id>.'); return; }
    try{
      const res = await safeFetch(DELETE_URL, { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key': API_KEY }, body: JSON.stringify({ id, hard:false }) });
      const jr = await safeJson(res);
      if(!res.ok) throw new Error(jr && jr.error ? jr.error : `HTTP ${res.status}`);
      await tgSend(chatId, `🗑️ Eliminado correctamente (ID: ${id}).`);
    }catch(err){ await tgSend(chatId, `❌ Error eliminando: ${sanitize(err.message)}`); await notifyAdmin(`DELETE fail id=${id}: ${err.message}`); }
    return;
  }

  // /listo
  if(text === '/listo'){
    const ok = await acquireLock(chatId, 5000);
    if(!ok){ await tgSend(chatId, 'Servidor ocupado. Reintentá en un momento.'); return; }
    try{
      if(!s.data.title){ await tgSend(chatId, 'Falta el título. Enviá el nombre de la prenda.'); s.step = 'ask_title'; return; }
      if(!s.images || s.images.length === 0){ await tgSend(chatId, 'No encontré imágenes. Enviá fotos.'); return; }
      if(!s.data.price){ await tgSend(chatId, 'Falta el precio. Ingresá el precio en ARS.'); s.step = 'price'; return; }

      const desc = productDescription({ fabric: s.data.fabric, sizes: s.data.sizes, price: s.data.price });
      const tags = productTags({ fabric: s.data.fabric, sizes: s.data.sizes });

      let addResp;
      try{ addResp = await createProduct({ title: s.data.title, description: desc, images: s.images, tags, price: s.data.price }); }
      catch(err){ await tgSend(chatId, `❌ Error creando producto: ${sanitize(err.message)}`); await notifyAdmin(`ADD fail: ${err.message}`); return; }

      // update data.json once
      try{
        const newItem = { id: addResp.id || `bot_${Date.now()}`, title: s.data.title, description: desc, images: s.images, tags, price: s.data.price, created_at: new Date().toISOString() };
        await appendToDataJson(newItem);
      }catch(err){ await notifyAdmin(`PUT data.json fail: ${err.message}`); }

      await tgSend(chatId, `✅ Subido\n${s.data.title}\n${desc}\n\n[ID: ${addResp.id || 'no-id'}]\n\nPara eliminar, respondé con /eliminar`);
      resetSession(chatId);
    }finally{ releaseLock(chatId); }
    return;
  }

  // flows
  if(s.step === 'ask_title'){
    let title = text; if(title.length > 120) title = title.slice(0,120);
    s.data.title = title; s.step = 'fabric';
    await tgSend(chatId, 'Elige la tela:', { parse_mode:'HTML', reply_markup: fabricKeyboard(0) });
    return;
  }
  if(s.step === 'price'){
    const price = Number(text.replace(/[^\d]/g,'')) || 0;
    if(!price){ await tgSend(chatId, 'Ingresá un número válido para el precio.'); return; }
    s.data.price = price; s.step = null; await tgSend(chatId, '✔️ Precio guardado. Enviá /listo para publicar.'); return;
  }

  await tgSend(chatId, 'Enviá una foto o un álbum para comenzar. /start');
}

// main handler
exports.handler = async (event) => {
  // Always return 200 to Telegram quickly; handle errors internally and notify admin.
  if(event.httpMethod !== 'POST') return { statusCode: 200, body: 'ok' };

  try{
    const update = JSON.parse(event.body || '{}');

    if(update.message){
      const msg = update.message;
      // prioritize photos & documents
      if(msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image'))){
        await handlePhoto(msg);
      } else if(typeof msg.text === 'string'){
        await handleText(msg);
      } else {
        if(msg.chat && msg.chat.id) await tgSend(msg.chat.id, 'Mandá una foto o /start.');
      }
    } else if(update.callback_query){
      await handleCallback(update.callback_query);
    } else {
      // Unhandled update types: just notify admin (don't crash)
      await notifyAdmin(`Unhandled update types: ${Object.keys(update).join(', ')}`);
    }
  }catch(err){
    console.error('[tgWebhook] unhandled error', err && err.stack ? err.stack : err);
    try{ await notifyAdmin(`Webhook crash: ${err && err.message ? err.message : String(err)}`); }catch(e){}
    // always return 200 to Telegram
  } finally {
    return { statusCode: 200, body: JSON.stringify({ ok:true }) };
  }
};