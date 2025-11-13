// netlify/functions/tgWebhook.js
'use strict';

/**
 * Webhook mejorado para Telegram (Netlify)
 * - Usa Redis para sesiones/locks (REDIS_URL opcional, si no está usa in-memory con advertencia)
 * - Usa github.js para interacciones con el repo (upload/get/put/delete)
 * - Optimistic retry en appendToDataJson
 * - Validaciones y límites
 */

const { uploadFileToRepo, getDataJSON, putDataJSON, deleteFileFromRepo } = require('./github');
const Redis = require('ioredis');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const API_KEY = process.env.API_KEY || '';
const ADD_URL = process.env.ADD_URL || '';
const DELETE_URL = process.env.DELETE_URL || '';
const ADMIN = process.env.ADMIN_CHAT_ID || '';
const REDIS_URL = process.env.REDIS_URL || ''; // ej: redis://:password@host:6379/0

if(!BOT_TOKEN) console.warn('[tgWebhook] BOT_TOKEN not set');
if(!API_KEY) console.warn('[tgWebhook] API_KEY not set');
if(!ADD_URL) console.warn('[tgWebhook] ADD_URL not set');
if(!DELETE_URL) console.warn('[tgWebhook] DELETE_URL not set');
if(!ADMIN) console.warn('[tgWebhook] ADMIN_CHAT_ID not set');

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const TG_FILE = BOT_TOKEN ? `https://api.telegram.org/file/bot${BOT_TOKEN}` : null;

const DEFAULT_TIMEOUT = 15000;
const NETWORK_RETRIES = 3;
const MAX_IMAGES_PER_SESSION = 12;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
const ALBUM_WAIT_MS = 900; // wait up to 900ms to collect album photos from same media_group_id
const DATA_JSON_RETRIES = 4;
const IMAGE_BATCH_DELETE = 6;

// catalogos (ejemplo)
const FABRICS = [ 'algodón','lino','viscosa','modal','jean','saten','poliéster','rayón','algodon rustico' ];
const SIZES = [ '1 ( S )','2 ( M )','3 ( L )','4 ( XL )','5 ( XXL )','unico','36','38','40','42' ];

// fetch (serverless Node 18+ tiene global fetch)
const fetch = global.fetch || require('node-fetch');

// Redis (opcional). Si no está, se usa in-memory — advertencia: no persistente.
let redis;
let usingRedis = false;
if(REDIS_URL){
  redis = new Redis(REDIS_URL);
  usingRedis = true;
  redis.on('error', (e)=>console.error('[redis] error', e.message));
} else {
  console.warn('[tgWebhook] REDIS_URL not set — using in-memory sessions/locks (not recommended for production)');
}

// In-memory fallback (only used if REDIS_URL absent)
const INMEM = {
  SESSIONS: new Map(),
  LOCKS: new Set()
};
function now(){ return Date.now(); }

// Helpers: redis-backed session storage (or in-memory)
async function getSession(chatId){
  if(usingRedis){
    const key = `session:${chatId}`;
    const raw = await redis.get(key);
    if(raw) return JSON.parse(raw);
    const s = { step:null, data:{}, images:[], albumId:null, selectedSizes:[], processing:false, lastMsgId:null, albumWaitUntil:0 };
    await redis.set(key, JSON.stringify(s), 'EX', 3600);
    return s;
  } else {
    let s = INMEM.SESSIONS.get(chatId);
    if(!s){ s = { step:null, data:{}, images:[], albumId:null, selectedSizes:[], processing:false, lastMsgId:null, albumWaitUntil:0 }; INMEM.SESSIONS.set(chatId, s); }
    return s;
  }
}
async function setSession(chatId, session){
  if(usingRedis){
    const key = `session:${chatId}`;
    await redis.set(key, JSON.stringify(session), 'EX', 3600);
  } else {
    INMEM.SESSIONS.set(chatId, session);
  }
}
async function resetSession(chatId){
  if(usingRedis){ await redis.del(`session:${chatId}`); }
  else { INMEM.SESSIONS.delete(chatId); }
}

// Locks: redis-based or in-memory
async function acquireLock(chatId, ttl = 5000){
  const key = `lock:${chatId}`;
  if(usingRedis){
    const lockVal = `${process.pid}_${Date.now()}`;
    const ok = await redis.set(key, lockVal, 'NX', 'PX', ttl);
    return !!ok;
  } else {
    const start = Date.now();
    while(true){
      if(!INMEM.LOCKS.has(chatId)){ INMEM.LOCKS.add(chatId); return true; }
      if(Date.now() - start > ttl) return false;
      await new Promise(r=>setTimeout(r,50));
    }
  }
}
async function releaseLock(chatId){
  if(usingRedis){ await redis.del(`lock:${chatId}`).catch(()=>{}); }
  else { INMEM.LOCKS.delete(chatId); }
}

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
    catch(err){ last = err; await new Promise(r=>setTimeout(r, 150 * Math.pow(2,i))); }
  }
  throw last;
}
async function safeJson(res){
  try{ return await res.json(); }catch(e){ return null; }
}
function sanitize(s){ if(!s) return ''; return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,500); }
function normalizeFilename(name='item'){ return name.toString().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_').replace(/[^a-z0-9_\-\.]/g,'').slice(0,140); }

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
    }catch(err){ last = err; await new Promise(r=>setTimeout(r, 120 * Math.pow(2,i))); }
  }
  throw last;
}
async function tgSend(chat_id, text, extras = {}){ try{ return await tgCall('sendMessage', { chat_id, text, ...extras }); }catch(e){ console.warn('[tgSend] ', e.message); } }
async function tgAnswerCallback(id, text=''){ try{ await tgCall('answerCallbackQuery', { callback_query_id:id, text }); }catch(e){} }
async function getFileUrl(file_id){ const r = await tgCall('getFile', { file_id }); const path = r.result && r.result.file_path; if(!path) throw new Error('getFile: no file_path'); return `${TG_FILE}/${path}`; }
async function notifyAdmin(msg){ if(!ADMIN) return; try{ await tgSend(ADMIN, `⚠️ ${msg}`, { parse_mode:'HTML' }); }catch(e){ console.warn('[notifyAdmin]', e.message); } }

// Keyboards
function fabricKeyboard(page=0){ const perPage=12, perRow=2, start=page*perPage; const slice=FABRICS.slice(start,start+perPage); const rows=[]; for(let i=0;i<slice.length;i+=perRow) rows.push(slice.slice(i,i+perRow).map(f=>({ text:f, callback_data:`fab|${f}` }))); const nav=[]; if(start>0) nav.push({ text:'«', callback_data:`fabpage|${page-1}` }); if(start+perPage<FABRICS.length) nav.push({ text:'»', callback_data:`fabpage|${page+1}` }); if(nav.length) rows.push(nav); return { inline_keyboard: rows }; }
function sizesKeyboard(selected=[]){ const perRow=4, rows=[]; const selectedSet = new Set(selected); for(let i=0;i<SIZES.length;i+=perRow){ rows.push(SIZES.slice(i,i+perRow).map(sz=>({ text: selectedSet.has(sz) ? `✅ ${sz}` : sz, callback_data:`size|${sz}` }))); } rows.push([{ text:'Continuar ▶', callback_data:'sizes_done' }]); return { inline_keyboard: rows }; }
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

// create product via ADD_URL
async function createProductRemote({ title, description, images, tags, price }){
  if(!ADD_URL) throw new Error('ADD_URL missing');
  const body = { title, description, images, tags, price };
  const res = await safeFetch(ADD_URL, { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key': API_KEY }, body: JSON.stringify(body) }, NETWORK_RETRIES);
  const j = await safeJson(res);
  if(!res.ok) throw new Error(j && j.error ? j.error : `HTTP ${res.status}`);
  return j;
}

// appendToDataJson with optimistic retry (uses github.js getDataJSON/putDataJSON)
async function appendToDataJson(newItem){
  for(let attempt=0; attempt<DATA_JSON_RETRIES; attempt++){
    try{
      const pj = await getDataJSON();
      const items = pj.items || [];
      const sha = pj.sha;
      items.push(newItem);
      await putDataJSON({ items, sha, message: `add via bot id:${newItem.id||'bot_'+Date.now()}` });
      return;
    }catch(err){
      // If conflict, retry after small delay
      console.warn('[appendToDataJson] attempt failed', attempt, err.message);
      await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
      if(attempt === DATA_JSON_RETRIES - 1) throw err;
    }
  }
}

// Handlers

async function handleStart(chatId){
  const txt = 'Hola 👋 Soy el bot de catálogo.\nEnviame una foto (o un álbum) y te ayudo a cargarla.\nFlujo: foto → nombre → tela → talles → precio → /listo';
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
  const gotLock = await acquireLock(chatId, 5000);
  if(!gotLock){ await tgSend(chatId, 'Servidor ocupado. Reintentá en un momento.'); return; }
  try{
    const s = await getSession(chatId);
    const photo = (msg.photo||[]).slice(-1)[0];
    const doc = (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image')) ? msg.document : null;
    const fileObj = photo || doc;
    if(!fileObj){ await tgSend(chatId, 'No identifiqué la imagen. Mandá como foto o documento de imagen.'); return; }

    // enforce max images per session
    if((s.images||[]).length >= MAX_IMAGES_PER_SESSION){ await tgSend(chatId, `Máximo ${MAX_IMAGES_PER_SESSION} imágenes por producto.`); return; }

    // filename
    const base = normalizeFilename(s.data.title || `item_${chatId}`) + '_' + Date.now();
    const idx = (s.images.length || 0) + 1;
    const fname = `${base}_${idx}.jpg`;

    // get file url from telegram
    let url;
    try{ url = await getFileUrl(fileObj.file_id); }catch(err){ await notifyAdmin(`getFile fail: ${err.message}`); await tgSend(chatId, 'Error obteniendo imagen.'); return; }

    // fetch metadata first (HEAD) to check size (some servers may not support HEAD)
    try{
      const head = await safeFetch(url, { method:'GET' }, 8000);
      const contentLength = head.headers && (head.headers.get('content-length') || head.headers.get('Content-Length'));
      const size = contentLength ? Number(contentLength) : null;
      if(size && size > MAX_IMAGE_BYTES){ await tgSend(chatId, `Archivo demasiado grande (>${Math.round(MAX_IMAGE_BYTES/1024/1024)}MB).`); return; }
    }catch(e){
      // continue: we'll fetch and verify during upload attempt
    }

    // upload to repo via github.js
    try{
      // uploadFileToRepo should download the url and commit to repo
      await uploadFileToRepo(url, `images/${fname}`, { maxBytes: MAX_IMAGE_BYTES });
      s.images = s.images || [];
      s.images.push(fname);
      // album handling
      const mgid = msg.media_group_id || null;
      if(mgid){
        // If new album id, start album flow and wait a little to collect other album photos
        if(!s.albumId || s.albumId !== mgid){
          s.albumId = mgid;
          s.albumWaitUntil = Date.now() + ALBUM_WAIT_MS;
          s.selectedSizes = [];
          s.step = 'album_confirm';
          await setSession(chatId, s);
          await tgSend(chatId, '📸 Detecté un álbum. ¿Todas las fotos son de la misma prenda?', { reply_markup: yesNoKeyboard('same_item') });
        } else {
          // same album, silent add
          await setSession(chatId, s);
        }
      } else {
        s.albumId = null;
        s.selectedSizes = [];
        s.step = s.step || 'ask_title';
        await setSession(chatId, s);
        if(s.step === 'ask_title') await tgSend(chatId, '📝 Decime el nombre de la prenda.');
        else await tgSend(chatId, 'Imagen recibida. Podés enviar más o escribir el nombre.');
      }
    }catch(err){
      await notifyAdmin(`uploadFile fail ${fname}: ${err.message}`);
      await tgSend(chatId, 'Error subiendo imagen al repo.');
      return;
    }
  }finally{ await releaseLock(chatId); }
}

async function handleCallback(query){
  const id = query.id;
  const msg = query.message;
  const chatId = msg && msg.chat && msg.chat.id;
  if(!chatId){ try{ await tgAnswerCallback(id,'Error interno'); }catch(e){} return; }
  const s = await getSession(chatId);
  const data = query.data || '';
  try{
    if(data.startsWith('fabpage|')){ const page = Number(data.split('|')[1]||'0')||0; await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: fabricKeyboard(page) }); return; }
    if(data.startsWith('fab|')){ const fab = data.split('|')[1]; s.data.fabric = fab; s.step = 'sizes'; await setSession(chatId, s); await tgCall('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: `Tela seleccionada: <b>${fab}</b>`, parse_mode:'HTML' }); await tgSend(chatId, 'Elegí los talles:', { parse_mode:'HTML', reply_markup: sizesKeyboard(s.selectedSizes) }); return; }
    if(data.startsWith('size|')){ const sz = data.split('|')[1]; if(!sz) return; s.selectedSizes = s.selectedSizes || []; if(s.selectedSizes.includes(sz)) s.selectedSizes = s.selectedSizes.filter(x=>x!==sz); else s.selectedSizes.push(sz); await setSession(chatId, s); await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: sizesKeyboard(s.selectedSizes) }); return; }
    if(data === 'sizes_done'){ s.data.sizes = new Set(s.selectedSizes || []); s.step = 'price'; await setSession(chatId, s); await tgSend(chatId, '💵 Ingresá el precio en ARS (solo números).'); return; }
    if(data.startsWith('yes|') || data.startsWith('no|')){ const key = data.split('|')[1]; if(key === 'same_item'){ if(data.startsWith('yes|')){ s.step = 'ask_title'; await setSession(chatId, s); await tgSend(chatId, '📝 Decime el nombre de la prenda.'); } else { s.images = []; s.albumId = null; s.step = null; await setSession(chatId, s); await tgSend(chatId, 'Ok — cada foto será tratada por separado. Enviá nombre para la primera foto.'); } } await tgCall('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(()=>{}); return; }
  }catch(err){ await notifyAdmin(`callback error: ${err.message}`); } finally { try{ await tgAnswerCallback(id); }catch(e){} }
}

async function handleText(msg){
  const chatId = msg.chat && msg.chat.id;
  if(!chatId) return;
  const text = (msg.text || '').trim();
  const s = await getSession(chatId);

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
      if(!s.data.title){ await tgSend(chatId, 'Falta el título. Enviá el nombre de la prenda.'); s.step = 'ask_title'; await setSession(chatId, s); return; }
      if(!s.images || s.images.length === 0){ await tgSend(chatId, 'No encontré imágenes. Enviá fotos.'); return; }
      if(!s.data.price){ await tgSend(chatId, 'Falta el precio. Ingresá el precio en ARS.'); s.step = 'price'; await setSession(chatId, s); return; }

      const desc = productDescription({ fabric: s.data.fabric, sizes: s.data.sizes, price: s.data.price });
      const tags = productTags({ fabric: s.data.fabric, sizes: s.data.sizes });

      let addResp;
      try{ addResp = await createProductRemote({ title: s.data.title, description: desc, images: s.images, tags, price: s.data.price }); }
      catch(err){ await tgSend(chatId, `❌ Error creando producto: ${sanitize(err.message)}`); await notifyAdmin(`ADD fail: ${err.message}`); return; }

      // update data.json once (optimistic)
      try{
        const newItem = { id: addResp.id || `bot_${Date.now()}`, title: s.data.title, description: desc, images: s.images, tags, price: s.data.price, created_at: new Date().toISOString() };
        await appendToDataJson(newItem);
      }catch(err){ await notifyAdmin(`PUT data.json fail: ${err.message}`); /* don't block user */ }

      await tgSend(chatId, `✅ Subido\n${s.data.title}\n${desc}\n\n[ID: ${addResp.id || 'no-id'}]\n\nPara eliminar, respondé con /eliminar`);
      await resetSession(chatId);
    }finally{ await releaseLock(chatId); }
    return;
  }

  // flows
  if(s.step === 'ask_title'){
    let title = text; if(title.length > 120) title = title.slice(0,120);
    s.data.title = title; s.step = 'fabric';
    await setSession(chatId, s);
    await tgSend(chatId, 'Elige la tela:', { parse_mode:'HTML', reply_markup: fabricKeyboard(0) });
    return;
  }
  if(s.step === 'price'){
    const price = Number(text.replace(/[^\d]/g,'')) || 0;
    if(!price){ await tgSend(chatId, 'Ingresá un número válido para el precio.'); return; }
    s.data.price = price; s.step = null; await setSession(chatId, s); await tgSend(chatId, '✔️ Precio guardado. Enviá /listo para publicar.'); return;
  }

  await tgSend(chatId, 'Enviá una foto o un álbum para comenzar. /start');
}

// main handler
exports.handler = async (event) => {
  // Always return 200 to Telegram quickly; but we do process synchronously (Netlify functions must finish).
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