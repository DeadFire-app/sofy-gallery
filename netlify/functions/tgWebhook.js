// netlify/functions/tgWebhook.js
// Implementación completa: tg webhook + todas las funciones listadas
'use strict';

/*
  Requisitos:
  - Node 18+ (Netlify functions)
  - ./github.js con las funciones:
    uploadFileToRepo(urlOrBuffer, filename) -> Promise
    getDataJSON() -> Promise<{items, sha}>
    putDataJSON({ items, sha, message }) -> Promise
    deleteFileFromRepo(path) -> Promise
  - Env vars: BOT_TOKEN, API_KEY, ADD_URL, DELETE_URL, ADMIN_CHAT_ID
*/

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const API_KEY = process.env.API_KEY || '';
const ADD_URL = process.env.ADD_URL || '';
const DELETE_URL = process.env.DELETE_URL || '';
const ADMIN = process.env.ADMIN_CHAT_ID || '';

const { uploadFileToRepo, getDataJSON, putDataJSON, deleteFileFromRepo } = require('./github.js');

if(!BOT_TOKEN) console.warn('[tgWebhook] BOT_TOKEN no configurado');
if(!API_KEY) console.warn('[tgWebhook] API_KEY no configurada');
if(!ADD_URL) console.warn('[tgWebhook] ADD_URL no configurada');
if(!DELETE_URL) console.warn('[tgWebhook] DELETE_URL no configurada');
if(!ADMIN) console.warn('[tgWebhook] ADMIN_CHAT_ID no configurado');

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const TG_FILE = BOT_TOKEN ? `https://api.telegram.org/file/bot${BOT_TOKEN}` : null;

const DEFAULT_TIMEOUT = 15000;
const NETWORK_RETRIES = 2;
const IMG_BATCH = 6;

const FABRICS = [ 'algodón','algodón peinado','lino','viscosa','modal','frisa','rústico','morley','micromorley','wafle','fibrana','crepe','tull','broderie','bremer','lycra','spandex','gabardina','bengalina','jean','engomado','ecocuero','satén','poliéster','rayón','hawaii','CEY','Jersey','sastrero con spandex','sastrero con lycra','sastrero barbie','cey lino','lino morley con lycra','microfibra con lycra','crochet algodon con lycra','crochet con lycra','tylor con lycra','poplin','saten','saten sastrero','crep sastrero','morley lino','morley lino con lycra','strech con lycra','hilo Spandex','tull con stras','rompeviento','fibrana','hawaii con broderie','algodon rustico' ];
const SIZES = [ '1 ( S )','2 ( M )','3 ( L )','4 ( XL )','5 ( XXL )','6 ( XXXL )','7','8','9','10','11','12','unico','36','38','40','42','44','46','48','50','52','54','56','58' ];

// ----- Sessions and locks (in-memory; Netlify may cold-start) -----
const SESSIONS = new Map();
const LOCKS = new Set();

function session(chatId){
  if(!SESSIONS.has(chatId)){
    SESSIONS.set(chatId, {
      step: null,
      data: {},        // title, fabric, sizes:Set, price
      images: [],      // filenames uploaded to repo
      albumId: null,
      selectedSizes: new Set(),
      processing: false
    });
  }
  return SESSIONS.get(chatId);
}
function resetSession(chatId){ SESSIONS.delete(chatId); }

async function acquireLock(chatId, timeout = 3000){
  const start = Date.now();
  while(true){
    if(!LOCKS.has(chatId)){ LOCKS.add(chatId); return true; }
    if(Date.now() - start > timeout) return false;
    await new Promise(r=>setTimeout(r,50));
  }
}
async function releaseLock(chatId){ LOCKS.delete(chatId); }

// -------------------- Network helpers --------------------
async function fetchWithTimeout(url, opts = {}, timeout = DEFAULT_TIMEOUT){
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
    try{ return await fetchWithTimeout(url, opts); }
    catch(err){ last = err; await new Promise(r=>setTimeout(r, 150 * Math.pow(2,i))); }
  }
  throw last;
}
async function safeJson(res){ try{ return await res.json(); }catch(e){ return null; }}

// -------------------- Telegram helpers --------------------
async function tg(method, payload = {}, retries = NETWORK_RETRIES){
  if(!TG_API) throw new Error('BOT_TOKEN no configurado');
  const url = `${TG_API}/${method}`;
  let last;
  for(let i=0;i<=retries;i++){
    try{
      const res = await safeFetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const j = await safeJson(res) || {};
      if(!j.ok) throw new Error(`TG ${method} error ${res.status} ${JSON.stringify(j)}`);
      return j;
    }catch(err){ last = err; await new Promise(r=>setTimeout(r, 120 * Math.pow(2,i))); }
  }
  throw last;
}

async function sendMessage(chat_id, text, extras = {}){
  return tg('sendMessage', { chat_id, text, ...extras });
}

async function sendPhoto(chat_id, photoUrl, caption = '', extras = {}){
  // using sendPhoto method with photo URL
  return tg('sendPhoto', { chat_id, photo: photoUrl, caption, ...extras });
}

async function answerCallback(callback_query_id, text = ''){ return tg('answerCallbackQuery', { callback_query_id, text }); }

async function getFileUrl(file_id){
  const r = await tg('getFile', { file_id });
  const path = r.result && r.result.file_path;
  if(!path) throw new Error('No file_path');
  return `${TG_FILE}/${path}`;
}

async function notifyAdmin(msg){
  if(!ADMIN) return;
  try{ await sendMessage(ADMIN, `⚠️ ${msg}`, { parse_mode: 'HTML' }); }catch(e){ console.warn('[notifyAdmin]', e.message); }
}

// -------------------- Keyboard helpers --------------------
function fabricKeyboard(page = 0){
  const perPage = 12, perRow = 2;
  const start = page*perPage;
  const slice = FABRICS.slice(start, start+perPage);
  const rows = [];
  for(let i=0;i<slice.length;i+=perRow) rows.push(slice.slice(i,i+perRow).map(f=>({ text:f, callback_data:`fab|${f}`})));
  const nav = [];
  if(start>0) nav.push({ text:'«', callback_data:`fabpage|${page-1}` });
  if(start+perPage < FABRICS.length) nav.push({ text:'»', callback_data:`fabpage|${page+1}` });
  if(nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

function sizesKeyboard(selected = new Set()){
  const perRow = 4, rows = [];
  for(let i=0;i<SIZES.length;i+=perRow){
    rows.push(SIZES.slice(i,i+perRow).map(sz=>({ text: selected.has(sz) ? `✅ ${sz}` : sz, callback_data:`size|${sz}` })));
  }
  rows.push([{ text:'Continuar ▶', callback_data:'sizes_done' }]);
  return { inline_keyboard: rows };
}

function yesNoKeyboard(key){ return { inline_keyboard: [[{ text:'Sí', callback_data:`yes|${key}` },{ text:'No', callback_data:`no|${key}` }]] }; }

// -------------------- Product utilities --------------------
function normalizeFilename(str){ return (str||'item').toString().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'_').replace(/[^a-z0-9_\-\.]/g,'').slice(0,180); }
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

// -------------------- Core features (create/update/delete) --------------------
async function createProductEntry({ title, description, images, tags, price }){
  // POST to ADD_URL with API_KEY
  if(!ADD_URL) throw new Error('ADD_URL not configured');
  const body = { title, description, images, tags, price };
  const res = await safeFetch(ADD_URL, { method:'POST', headers: { 'Content-Type':'application/json', 'x-api-key': API_KEY }, body: JSON.stringify(body) }, NETWORK_RETRIES);
  const j = await safeJson(res);
  if(!res.ok) throw new Error((j && j.error) ? j.error : `HTTP ${res.status}`);
  return j;
}

async function updateDataJSONOnce(newItem){
  // getDataJSON & putDataJSON
  const pj = await getDataJSON();
  const items = pj.items || [];
  const sha = pj.sha;
  items.push(newItem);
  await putDataJSON({ items, sha, message: `add via bot id:${newItem.id||'bot_'+Date.now()}` });
}

async function deleteProductById(id){
  // call DELETE_URL + optionally delete images via deleteFileFromRepo
  if(!DELETE_URL) throw new Error('DELETE_URL not configured');
  const res = await safeFetch(DELETE_URL, { method:'POST', headers:{ 'Content-Type':'application/json','x-api-key': API_KEY }, body: JSON.stringify({ id, hard:false }) });
  const j = await safeJson(res);
  if(!res.ok) throw new Error((j && j.error) ? j.error : `HTTP ${res.status}`);
  return j;
}

// -------------------- Handlers --------------------
async function handleStart(chatId){
  const txt = 'Hola 👋 Soy el bot de catálogo Sofy.\nEnviame una foto (o un álbum) y te ayudo a cargarla.\nFlujo: foto → nombre → tela → talles → precio → /listo';
  await sendMessage(chatId, txt);
}

async function handleReset(chatId){
  try{
    const pj = await getDataJSON();
    const items = pj.items || [];
    const sha = pj.sha;
    // gather images and delete in batches
    const allImgs = [];
    for(const it of items) if(it.images) allImgs.push(...it.images);
    for(let i=0;i<allImgs.length;i+=IMG_BATCH){
      const batch = allImgs.slice(i,i+IMG_BATCH).map(n=> deleteFileFromRepo(`images/${n}`).catch(()=>{}));
      await Promise.all(batch);
    }
    await putDataJSON({ items: [], sha, message: 'reset via bot' });
    await sendMessage(chatId, '✅ RESET completo: se borraron productos e imágenes.');
  }catch(err){
    await sendMessage(chatId, `❌ Error en RESET: ${err.message}`);
    await notifyAdmin(`RESET fail: ${err.message}`);
  }
}

async function handlePhoto(msg){
  const chatId = msg.chat && msg.chat.id;
  if(!chatId) return;
  const gotLock = await acquireLock(chatId, 3000);
  if(!gotLock){ await sendMessage(chatId, 'Servidor ocupado, reintentá en un segundo.'); return; }
  try{
    const s = session(chatId);
    // accept photo[] or document image
    const ph = (msg.photo || []).slice(-1)[0];
    const doc = (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image')) ? msg.document : null;
    const file = ph || doc;
    if(!file){ await sendMessage(chatId, 'No pude identificar la imagen. Enviá como foto o como documento.'); return; }

    const fileUrl = await getFileUrl(file.file_id);
    const base = normalizeFilename(s.data.title || `item_${chatId}`) + '_' + Date.now();
    const index = (s.images.length||0) + 1;
    const fname = `${base}_${index}.jpg`;

    try{
      await uploadFileToRepo(fileUrl, fname);
      s.images.push(fname);
    }catch(err){
      await sendMessage(chatId, '❌ Error subiendo la imagen. Avisé al administrador.');
      await notifyAdmin(`uploadFileToRepo fail: ${err.message}`);
      return;
    }

    const mgid = msg.media_group_id || null;
    if(mgid){
      if(!s.albumId || s.albumId !== mgid){
        s.albumId = mgid; s.selectedSizes = new Set(); s.data = s.data || {}; s.step = 'album_confirm';
        await sendMessage(chatId, '📸 Detecté un álbum. ¿Todas las fotos son de la misma prenda? (Sí/No)', { reply_markup: yesNoKeyboard('same_item') });
      } else {
        // part of same album: silent
      }
    } else {
      s.albumId = null; s.selectedSizes = new Set(); s.step = s.step || 'ask_title';
      if(s.step === 'ask_title') await sendMessage(chatId, '📝 Decime el nombre de la prenda.');
      else await sendMessage(chatId, 'Imagen recibida. Podés enviar más fotos o escribir el nombre.');
    }
  }finally{ await releaseLock(chatId); }
}

async function processCallback(query){
  const id = query.id;
  const msg = query.message;
  const chatId = msg && msg.chat && msg.chat.id;
  if(!chatId){ await answerCallback(id); return; }
  const s = session(chatId);
  const data = query.data || '';
  try{
    if(data.startsWith('fabpage|')){
      const page = Number(data.split('|')[1]||'0')||0;
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: fabricKeyboard(page) });
      return;
    }
    if(data.startsWith('fab|')){
      const fab = data.split('|')[1];
      s.data.fabric = fab; s.step = 'sizes';
      await tg('editMessageText', { chat_id, message_id: msg.message_id, text: `Tela seleccionada: <b>${fab}</b>`, parse_mode:'HTML' });
      await sendMessage(chatId, 'Elegí los talles:', { parse_mode:'HTML', reply_markup: sizesKeyboard(s.selectedSizes) });
      return;
    }
    if(data.startsWith('size|')){
      const sz = data.split('|')[1];
      if(!sz) return;
      if(s.selectedSizes.has(sz)) s.selectedSizes.delete(sz); else s.selectedSizes.add(sz);
      await tg('editMessageReplyMarkup', { chat_id, message_id: msg.message_id, reply_markup: sizesKeyboard(s.selectedSizes) });
      return;
    }
    if(data === 'sizes_done'){
      s.data.sizes = new Set(Array.from(s.selectedSizes));
      s.step = 'price';
      await sendMessage(chatId, '💵 Ingresá el precio (solo números).');
      return;
    }
    if(data.startsWith('yes|') || data.startsWith('no|')){
      const key = data.split('|')[1];
      if(key === 'same_item'){
        if(data.startsWith('yes|')){
          s.step = 'ask_title';
          await sendMessage(chatId, '📝 Decime el nombre de la prenda.');
        } else {
          // treat each image as individual
          s.images = [];
          s.albumId = null;
          s.step = null;
          await sendMessage(chatId, 'Ok — cada foto será tratada por separado. Enviá nombre para la primera foto.');
        }
      }
      await tg('editMessageReplyMarkup', { chat_id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(()=>{});
      return;
    }
  }catch(err){
    await notifyAdmin(`callback error: ${err.message}`);
  }finally{
    await answerCallback(id).catch(()=>{});
  }
}

async function handleText(msg){
  const chatId = msg.chat && msg.chat.id;
  if(!chatId) return;
  const text = (msg.text||'').trim();
  const s = session(chatId);

  if(text === '/start') return handleStart(chatId);
  if(text === '/reset') return handleReset(chatId);

  if(/^\/eliminar\b/i.test(text)){
    // attempt to extract id from reply or text
    let id = null;
    const reply = msg.reply_to_message && msg.reply_to_message.text;
    if(reply){
      const m = reply.match(/\[ID:\s*([^\]]+)\]/);
      if(m) id = m[1];
    }
    if(!id){
      const m2 = text.match(/\/eliminar\s+([^\s]+)/);
      if(m2) id = m2[1];
    }
    if(!id){ await sendMessage(chatId, 'Respondé al mensaje de confirmación con /eliminar o usa /eliminar <id>.'); return; }
    try{
      await safeFetch(DELETE_URL, { method:'POST', headers: { 'Content-Type':'application/json','x-api-key': API_KEY }, body: JSON.stringify({ id, hard:false }) });
      await sendMessage(chatId, `🗑️ Eliminado (ID: ${id}).`);
    }catch(err){
      await sendMessage(chatId, `❌ Error eliminando: ${err.message}`);
      await notifyAdmin(`DELETE fail id=${id}: ${err.message}`);
    }
    return;
  }

  if(text === '/listo'){
    const okLock = await acquireLock(chatId, 5000);
    if(!okLock){ await sendMessage(chatId, 'Servidor ocupado. Reintentá en 1s.'); return; }
    try{
      if(!s.data.title){ await sendMessage(chatId, 'Falta el título. Enviá nombre.'); s.step='ask_title'; return; }
      if(!s.images || s.images.length === 0){ await sendMessage(chatId, 'No hay imágenes. Enviá fotos primero.'); return; }
      if(!s.data.price){ await sendMessage(chatId, 'Falta precio. Ingresalo.'); s.step='price'; return; }

      const desc = productDescription({ fabric: s.data.fabric, sizes: s.data.sizes, price: s.data.price });
      const tags = productTags({ fabric: s.data.fabric, sizes: s.data.sizes });

      let addResp;
      try{ addResp = await createProductEntry({ title: s.data.title, description: desc, images: s.images, tags, price: s.data.price }); }
      catch(err){ await sendMessage(chatId, `❌ Error creando producto: ${err.message}`); await notifyAdmin(`ADD fail: ${err.message}`); return; }

      // update data.json once
      try{
        const newItem = { id: addResp.id || `bot_${Date.now()}`, title: s.data.title, description: desc, images: s.images, tags, price: s.data.price, created_at: new Date().toISOString() };
        await updateDataJSONOnce(newItem);
      }catch(err){
        await notifyAdmin(`PUT data.json fail: ${err.message}`);
      }

      await sendMessage(chatId, `✅ Subido\n${s.data.title}\n${desc}\n\n[ID: ${addResp.id || 'no-id'}]\n\nPara eliminar, respondé con /eliminar`);
      resetSession(chatId);
    }finally{ await releaseLock(chatId); }
    return;
  }

  // flows
  if(s.step === 'ask_title'){
    let t = text;
    if(t.length > 120) t = t.slice(0,120);
    s.data.title = t; s.step = 'fabric';
    await sendMessage(chatId, 'Elige la tela:', { parse_mode:'HTML', reply_markup: fabricKeyboard(0) });
    return;
  }

  if(s.step === 'price'){
    const num = Number(text.replace(/[^\d]/g,'')) || 0;
    if(!num){ await sendMessage(chatId, 'Ingresá un número válido para el precio.'); return; }
    s.data.price = num; s.step = null;
    await sendMessage(chatId, '✔️ Precio guardado. Enviá /listo para publicar.');
    return;
  }

  // default hint
  await sendMessage(chatId, 'Enviá una foto o un álbum para comenzar. /start');
}

// -------------------- Main handler --------------------
exports.handler = async function(event){
  if(event.httpMethod !== 'POST') return { statusCode:200, body:'ok' };
  try{
    const update = JSON.parse(event.body || '{}');

    if(update.message){
      const msg = update.message;
      if(msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image'))){
        await handlePhoto(msg);
      } else if(typeof msg.text === 'string'){
        await handleText(msg);
      } else {
        if(msg.chat && msg.chat.id) await sendMessage(msg.chat.id, 'Mandá una foto o /start.');
      }
    } else if(update.callback_query){
      await processCallback(update.callback_query);
    } else {
      await notifyAdmin(`Unhandled update type: ${Object.keys(update).join(', ')}`);
    }

    return { statusCode:200, body: JSON.stringify({ ok:true }) };
  }catch(err){
    console.error('[tgWebhook] handler error', err.message, err.stack||'');
    try{ await notifyAdmin(`Webhook crash: ${err.message}`); }catch(e){}
    return { statusCode:200, body: JSON.stringify({ ok:true }) };
  }
};