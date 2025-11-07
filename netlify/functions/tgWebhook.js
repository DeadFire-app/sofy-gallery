// netlify/functions/tgWebhook.js
// Versión reforzada — mantiene las funciones originales y les añade validaciones y manejo de errores.

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY;
const ADD_URL = process.env.ADD_URL;
const DELETE_URL = process.env.DELETE_URL;
const ADMIN = process.env.ADMIN_CHAT_ID;

const { uploadFileToRepo, getDataJSON, putDataJSON, deleteFileFromRepo } = require('./github.js');

if (!BOT_TOKEN) console.warn('[tgWebhook] Falta BOT_TOKEN');
if (!API_KEY) console.warn('[tgWebhook] Falta API_KEY');
if (!ADD_URL) console.warn('[tgWebhook] Falta ADD_URL');
if (!DELETE_URL) console.warn('[tgWebhook] Falta DELETE_URL');

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const TG_FILE = BOT_TOKEN ? `https://api.telegram.org/file/bot${BOT_TOKEN}` : null;

const FABRICS = [ 'algodón','algodón peinado','lino','viscosa','modal','frisa','rústico','morley','micromorley','wafle','fibrana','crepe','tull','broderie','bremer','lycra','spandex','gabardina','bengalina','jean','engomado','ecocuero','satén','poliéster','rayón','hawaii','CEY','Jersey','sastrero con spandex','sastrero con lycra','sastrero barbie','cey lino','lino morley con lycra','microfibra con lycra','crochet algodon con lycra','crochet con lycra','tylor con lycra','poplin','saten','saten sastrero','crep sastrero','morley lino','morley lino con lycra','strech con lycra','hilo Spandex','tull con stras','rompeviento','fibrana','hawaii con broderie','algodon rustico'];

const SIZES = [ '1 ( S )','2 ( M )','3 ( L )','4 ( XL )','5 ( XXL )','6 ( XXXL )','7','8','9','10','11','12','unico','36','38','40','42','44','46','48','50','52','54','56','58' ];

const SESSIONS = new Map();

function session(chatId) {
  let s = SESSIONS.get(chatId);
  if (!s) {
    s = {
      step: null,
      data: {},
      albumId: null,
      images: [],
      selectedSizes: new Set(),
      messageIds: [],
      lastTs: null,
      albumProcessing: false // flag para evitar prompts repetidos por álbum
    };
    SESSIONS.set(chatId, s);
  }
  return s;
}

/* ------------------ Utilidades seguras ------------------ */
async function safeJson(res) {
  try { return await res.json(); } catch (e) { return null; }
}
async function safeFetch(url, opts = {}, retries = 2, backoff = 200) {
  try {
    const res = await fetch(url, opts);
    return res;
  } catch (err) {
    if (retries > 0) {
      console.warn(`[safeFetch] retrying ${url} due to ${err.message}`);
      await new Promise(r => setTimeout(r, backoff));
      return safeFetch(url, opts, retries - 1, backoff * 2);
    }
    throw err;
  }
}
/* ------------------------------------------------------------------ */

async function tg(method, payload, retries = 2) {
  if (!TG_API) throw new Error('BOT_TOKEN no configurado');
  const url = `${TG_API}/${method}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await safeJson(res) || {};
      if (!json.ok) {
        const errTxt = `TG ${method} error: ${res.status} ${JSON.stringify(json)}`;
        if (attempt < retries) {
          console.warn(`${errTxt} — reintentando...`);
          await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(errTxt);
      }
      return json;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[tg] intento ${attempt + 1} falló: ${err.message}`);
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function getFileUrl(file_id){
  if (!file_id) throw new Error('file_id vacío');
  const file = await tg('getFile',{ file_id }).catch(err => { throw new Error('getFile fail: ' + err.message); });
  const path = file.result && file.result.file_path;
  if(!path) throw new Error('No file_path en respuesta de getFile');
  return `${TG_FILE}/${path}`;
}

function fabricKeyboard(page=0){
  const perRow = 2, perPage=12;
  const start = page*perPage;
  const slice = FABRICS.slice(start,start+perPage);
  const rows=[];
  for(let i=0;i<slice.length;i+=perRow) rows.push(slice.slice(i,i+perRow).map(f=>({ text:f, callback_data:`fab|${f}`})));
  const nav=[];
  if(start>0) nav.push({ text:'«', callback_data:`fabpage|${page-1}` });
  if(start+perPage<FABRICS.length) nav.push({ text:'»', callback_data:`fabpage|${page+1}` });
  if(nav.length) rows.push(nav);
  return { inline_keyboard:rows };
}

function sizesKeyboard(selected=new Set()){
  const perRow=4, rows=[];
  for(let i=0;i<SIZES.length;i+=perRow){
    const row = SIZES.slice(i,i+perRow).map(sz=>({ text:selected.has(sz)?`✅ ${sz}`:sz, callback_data:`size|${sz}` }));
    rows.push(row);
  }
  rows.push([{ text:'Continuar ▶', callback_data:'sizes_done' }]);
  return { inline_keyboard:rows };
}

function yesNoKeyboard(key){ return { inline_keyboard:[[{ text:'Sí', callback_data:`yes|${key}`},{ text:'No', callback_data:`no|${key}` }]] }; }

function normalizeFilename(str){ return (str||'item').toString().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,''); }

function productDescription({ fabric,sizes,price }){ const talla = Array.from(sizes||[]).join(', '); const ftxt = fabric ? (fabric[0].toUpperCase()+fabric.slice(1)) : '—'; const p = (Number(price)||0).toLocaleString('es-AR'); return `Tela: ${ftxt} · Talles: ${talla||'—'} · Precio: $${p} ARS`; }

function productTags({ fabric,sizes }){ const s = Array.from(sizes||[]); return [...(fabric?[fabric.toLowerCase()]:[]), ...s.map(x=>x.toLowerCase())]; }

async function sendAdmin(msg){ if(!ADMIN) return; try{ await tg('sendMessage',{ chat_id:ADMIN,text:`⚠️ ${msg}`,parse_mode:'HTML' }); }catch(e){ console.warn('[sendAdmin] error', e.message); } }

// ---------- Handlers ----------

async function handleStart(chatId){
  try{
    await tg('sendMessage',{ chat_id:chatId, text:'Hola 👋 Soy el bot de catálogo Sofy. Enviame una foto (o un álbum) y te ayudo a cargarla.\n\nConsejo: si subís varias fotos de la misma prenda, mandalas como álbum para hacer un único producto con carrusel.' });
  }catch(err){ console.warn('[handleStart] ',err.message); }
}

async function handleReset(chatId){
  try{
    const { items, sha } = await getDataJSON();
    // borrar imágenes del repo en paralelo
    const proms = [];
    for(const prod of items || []){
      for(const img of prod.images||[]){ 
        proms.push(deleteFileFromRepo(`images/${img}`).catch(e=>{ console.warn('deleteFileFromRepo fail',e.message); }));
      }
    }
    await Promise.all(proms);
    await putDataJSON({ items: [], sha, message:'reset: se eliminan todos los productos' });
    await tg('sendMessage',{ chat_id:chatId, text:'✅ RESET completo: se borraron productos y todas las imágenes.' });
  }catch(err){
    await tg('sendMessage',{ chat_id:chatId, text:`❌ Error en RESET: ${err.message}` });
    await sendAdmin(`RESET fail: ${err.message}`);
  }
}

async function handlePhoto(msg){
  const chatId = msg.chat.id;
  const s = session(chatId);

  // Determinar si es photo (array) o document
  let fileObj = null;
  if (msg.photo && msg.photo.length) fileObj = msg.photo.slice(-1)[0];
  else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image')) fileObj = msg.document;
  if(!fileObj){
    try{ await tg('sendMessage',{ chat_id:chatId, text:'No pude identificar la imagen enviada. Mandala como foto o como documento de imagen.' }); }catch(e){}
    return;
  }

  const mgid = msg.media_group_id || null;

  // Generar nombre de archivo único
  const base = normalizeFilename(s.data.title || 'item') + '_' + Date.now();
  const index = (s.images.length||0) + 1;
  const fname = `${base}_${index}.jpg`;

  // Obtener URL del archivo
  let url;
  try{
    url = await getFileUrl(fileObj.file_id);
  }catch(err){
    await sendAdmin(`Error getFileUrl: ${err.message}`);
    try{ await tg('sendMessage',{ chat_id:chatId, text:`❌ Error obteniendo la imagen: ${err.message}` }); }catch(){}
    return;
  }

  // Subir imagen al repo y almacenar sólo el nombre
  try{
    await uploadFileToRepo(url,fname); // github.js debe manejar la subida desde URL o desde buffer
    s.images.push(fname);
  }catch(err){
    await sendAdmin(`Error subiendo imagen ${fname}: ${err.message}`);
    try{ await tg('sendMessage',{ chat_id:chatId, text:`❌ Error subiendo la imagen: ${err.message}` }); }catch(){}
    return;
  }

  // Si viene en álbum, no spamear con prompts por cada foto
  if(mgid){
    if(!s.albumId || s.albumId !== mgid){
      s.albumId = mgid;
      s.selectedSizes = new Set();
      s.data = s.data || {};
      s.step = 'album_confirm';
      s.albumProcessing = true;
      try{
        await tg('sendMessage',{ chat_id:chatId, text:'📸 Detecté un álbum.\n¿Todas las fotos son de la misma prenda?', reply_markup: yesNoKeyboard('same_item') });
      }catch(e){ console.warn('[handlePhoto] sendMessage album', e.message); }
    } else {
      // misma albumId: no hacemos nada (ya se guardó la imagen)
    }
  } else {
    // Foto individual: iniciar flujo si no iniciado o si se esperaba título
    s.albumId = null;
    s.selectedSizes = new Set();
    s.step = s.step || 'ask_title';
    if (s.step === 'ask_title') {
      try{ await tg('sendMessage',{ chat_id:chatId, text:'📝 Decime el <b>nombre de la prenda</b>.', parse_mode:'HTML' }); }catch(e){}
    } else {
      // si no está pidiendo título, podemos sugerir escribir /listo cuando termine
      try{ await tg('sendMessage',{ chat_id:chatId, text:'Imagen recibida. Si querés podes enviar más fotos o ingresar el nombre con texto.' }); }catch(e){}
    }
  }
}

async function handleCallback(query){
  const chatId = query.message.chat.id;
  const s = session(chatId);
  const data = query.data || '';
  try{
    if(data.startsWith('fabpage|')){
      const page = Number(data.split('|')[1]||'0')||0;
      await tg('editMessageReplyMarkup',{ chat_id:chatId,message_id:query.message.message_id,reply_markup:fabricKeyboard(page) }); return;
    }
    if(data.startsWith('fab|')){
      const fab = data.split('|')[1];
      s.data.fabric = fab; s.step='sizes';
      await tg('editMessageText',{ chat_id:chatId,message_id:query.message.message_id,text:`Tela seleccionada: <b>${fab}</b>`,parse_mode:'HTML'});
      await tg('sendMessage',{ chat_id:chatId,text:'Elegí los <b>talles</b> (podés marcar varios) y tocá "Continuar ▶".',parse_mode:'HTML',reply_markup:sizesKeyboard(s.selectedSizes)});
      return;
    }
    if(data.startsWith('size|')){
      const sz = data.split('|')[1];
      if(!sz) return;
      if(s.selectedSizes.has(sz)) s.selectedSizes.delete(sz); else s.selectedSizes.add(sz);
      await tg('editMessageReplyMarkup',{ chat_id:chatId,message_id:query.message.message_id,reply_markup:sizesKeyboard(s.selectedSizes)});
      return;
    }
    if(data==='sizes_done'){
      s.data.sizes = new Set(Array.from(s.selectedSizes));
      s.step='price';
      await tg('sendMessage',{ chat_id:chatId,text:'💵 Ingresá el <b>precio</b> en ARS (solo números).',parse_mode:'HTML'}); return;
    }
    if(data.startsWith('yes|')||data.startsWith('no|')){
      const key=data.split('|')[1];
      if(key==='same_item'){
        if(data.startsWith('yes|')){
          s.step='ask_title';
          try{ await tg('sendMessage',{ chat_id:chatId,text:'📝 Decime el <b>nombre de la prenda</b>.',parse_mode:'HTML'}); }catch(e){}
        }else{
          // si NO son la misma prenda — cada imagen se trata como individual
          const imgs = [...s.images];
          s.images = [];
          s.albumId = null;
          s.albumProcessing = false;
          // Para no crear sesiones nuevas que ataquen la actual, avisamos al usuario:
          try{
            await tg('sendMessage',{ chat_id:chatId, text:'Entendido. Tratá cada foto como una prenda individual: enviá nombre para cada una cuando quieras.' });
            // dejamos que el usuario responda a cada foto si quiere
          }catch(e){}
        }
      }
      // limpiar markup del mensaje original del yes/no
      try{ await tg('editMessageReplyMarkup',{ chat_id:chatId,message_id:query.message.message_id,reply_markup:{ inline_keyboard:[] } }); }catch(e){}
      return;
    }
  }catch(err){
    await sendAdmin(`callback error: ${err.message}`);
    console.warn('[handleCallback] ', err.message);
  }finally{
    try{ await tg('answerCallbackQuery',{ callback_query_id:query.id }); }catch(e){}
  }
}

async function handleText(msg){
  const chatId = msg.chat.id;
  const text = (msg.text||'').trim();
  const s = session(chatId);

  // comandos directos
  if(text==='/start') return handleStart(chatId);
  if(text==='/reset') return handleReset(chatId);

  if(text.startsWith('/eliminar')){
    // Intentar obtener id desde mensaje citado o del texto
    let id = null;
    const reply = msg.reply_to_message && msg.reply_to_message.text;
    if(reply){
      const m = reply.match(/\[ID:\s*([^\]\s]+)\]/);
      if(m) id = m[1];
    }
    if(!id){
      // buscar en el propio texto
      const m2 = text.match(/\/eliminar\s+([^\s]+)/);
      if(m2) id = m2[1];
    }
    if(!id){
      await tg('sendMessage',{ chat_id:chatId,text:'Para eliminar, respondé al mensaje de confirmación “✅ Subido … [ID: …]” con /eliminar, o usa /eliminar <id>.' });
      return;
    }
    try{
      const res = await safeFetch(DELETE_URL,{
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY },
        body:JSON.stringify({ id, hard:false })
      });
      const j = await safeJson(res);
      if(!res.ok) throw new Error(JSON.stringify(j) || res.statusText);
      await tg('sendMessage',{ chat_id:chatId,text:`🗑️ Eliminado correctamente (ID: ${id}).` });
    }catch(err){
      await tg('sendMessage',{ chat_id:chatId,text:`❌ Error eliminando: ${err.message}` });
      await sendAdmin(`DELETE fail id=${id}: ${err.message}`);
    }
    return;
  }

  if(text==='/listo'){
    try{
      // validaciones
      if(!s.data.title) { await tg('sendMessage',{ chat_id:chatId,text:'Falta el título. Enviá el nombre de la prenda.' }); s.step='ask_title'; return; }
      if(!s.images || s.images.length===0){ await tg('sendMessage',{ chat_id:chatId,text:'No encontré imágenes para esta sesión. Enviá fotos primero.' }); return; }
      if(!s.data.price){ await tg('sendMessage',{ chat_id:chatId,text:'Falta el precio. Ingresá el precio en ARS.' }); s.step='price'; return; }

      // construir descripción y tags
      const desc = productDescription({ fabric:s.data.fabric, sizes:s.data.sizes, price:s.data.price });
      const tags = productTags({ fabric:s.data.fabric, sizes:s.data.sizes });

      // llamar al ADD_URL para crear el producto en el backend
      const body = { title:s.data.title, description:desc, images:s.images, tags, price: s.data.price };
      let addJson = null;
      try{
        const res = await safeFetch(ADD_URL,{
          method:'POST', headers:{ 'Content-Type':'application/json','x-api-key':API_KEY }, body:JSON.stringify(body)
        });
        addJson = await safeJson(res);
        if(!res.ok || !addJson) throw new Error(addJson && addJson.error ? addJson.error : `HTTP ${res.status}`);
        if(addJson.ok === false) throw new Error(addJson.error || JSON.stringify(addJson));
      }catch(err){
        await sendAdmin(`ADD fail (net): ${err.message}`);
        await tg('sendMessage',{ chat_id:chatId, text:`❌ Error creando producto en el sitio: ${err.message}` });
        return;
      }

      // ahora actualizar data.json UNA SOLA VEZ
      try{
        const { items, sha } = await getDataJSON();
        const newItem = {
          id: addJson.id || (`bot_${Date.now()}`),
          title: s.data.title,
          description: desc,
          images: s.images,
          tags,
          price: s.data.price,
          created_at: (new Date()).toISOString()
        };
        items.push(newItem);
        await putDataJSON({ items, sha, message: `add via bot id:${newItem.id}` });
      }catch(err){
        await sendAdmin(`PUT data.json fail: ${err.message}`);
        // no abortar: producto ya puede haber sido creado en ADD_URL
      }

      const conf = `✅ Subido\n${s.data.title}\n${desc}\n\n[ID: ${addJson.id || 'no-id'}]\n\nPara eliminar, respondé este mensaje con /eliminar`;
      await tg('sendMessage',{ chat_id:chatId,text:conf });

      // limpiar sesión
      s.step=null; s.data={}; s.images=[]; s.albumId=null; s.selectedSizes=new Set(); s.albumProcessing=false;
      return;
    }catch(err){
      await tg('sendMessage',{ chat_id:chatId,text:`❌ Error en /listo: ${err.message}` });
      await sendAdmin(`/listo error: ${err.message}`);
      return;
    }
  }

  // flujos de datos (título / precio / etc)
  if(s.step==='ask_title'){
    // validar longitud
    if(text.length > 120) text = text.slice(0,120);
    s.data.title = text; s.step='fabric';
    try{ await tg('sendMessage',{ chat_id:chatId,text:'Elige la <b>tela</b>:',parse_mode:'HTML',reply_markup:fabricKeyboard(0)}); }catch(e){}
    return;
  }

  if(s.step==='price'){
    const price = Number(text.replace(/[^\d]/g,'')||0); 
    if(!price){ await tg('sendMessage',{ chat_id:chatId,text:'Ingresá un número válido para el precio.' }); return; }
    s.data.price = price;
    try{ await tg('sendMessage',{ chat_id:chatId, text:'✔️ Precio guardado. Cuando termines de subir todas las fotos y configuraciones envía /listo para publicar todo.' }); }catch(e){}
    s.step=null;
    return;
  }

  // Si no coincide con flujo, sugerir inicio
  try{ await tg('sendMessage',{ chat_id:chatId,text:'Enviá una foto o un álbum para comenzar. /start' }); }catch(e){}
}

// ---------- Handler principal Netlify ----------

exports.handler = async(event)=>{
  if(event.httpMethod!=='POST') return { statusCode:200, body:'ok' };
  try{
    const update = JSON.parse(event.body||'{}');
    if(update.message){
      const msg = update.message;
      if(msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image'))) await handlePhoto(msg);
      else if(typeof msg.text==='string') await handleText(msg);
      else {
        try{ await tg('sendMessage',{ chat_id:msg.chat.id,text:'Mandá una foto o /start.' }); }catch(e){}
      }
    } else if(update.callback_query){ await handleCallback(update.callback_query); }
    return { statusCode:200, body:JSON.stringify({ ok:true }) };
  }catch(err){
    console.error('[tgWebhook] error',err);
    try{ await sendAdmin(`Webhook error: ${err.message}`); }catch(e){}
    // devolver 200 a Telegram para que no reintente infinitamente; ya notificamos al admin
    return { statusCode:200, body:JSON.stringify({ ok:true }) };
  }
};