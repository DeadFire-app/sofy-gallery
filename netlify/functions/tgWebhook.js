// netlify/functions/tgWebhook.js
// Versión original con refuerzos añadidos (NO se eliminó nada del original; solo se añadieron validaciones y manejo de errores)
// Versión modificada: sube imágenes a repo en images/ al recibirlas,
// pero NO actualiza data.json por cada imagen.
// Sólo actualiza data.json y crea el producto en ADD_URL cuando el usuario envía /listo.

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY;
const ADD_URL = process.env.ADD_URL;
const DELETE_URL = process.env.DELETE_URL;
const ADMIN = process.env.ADMIN_CHAT_ID;

const { uploadFileToRepo, getDataJSON, putDataJSON, deleteFileFromRepo } = require('./github.js');

if (!BOT_TOKEN) console.warn('[tgWebhook] Falta BOT_TOKEN');

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const FABRICS = [ 'algodón','algodón peinado','lino','viscosa','modal','frisa','rústico','morley','micromorley','wafle','fibrana','crepe','tull','broderie','bremer','lycra','spandex','gabardina','bengalina','jean','engomado','ecocuero','satén','poliéster','rayón','hawaii','CEY','Jersey','sastrero con spandex','sastrero con lycra','sastrero barbie','cey lino','lino morley con lycra','microfibra con lycra','crochet algodon con lycra','crochet con lycra','tylor con lycra','poplin','saten','saten sastrero','crep sastrero','morley lino','morley lino con lycra','strech con lycra','hilo Spandex','tull con stras','rompeviento','fibrana','hawaii con broderie','algodon rustico'];

const SIZES = [ '1 ( S )','2 ( M )','3 ( L )','4 ( XL )','5 ( XXL )','6 ( XXXL )','7','8','9','10','11','12','unico','36','38','40','42','44','46','48','50','52','54','56','58' ];

const SESSIONS = new Map(); 

function session(chatId) {
  let s = SESSIONS.get(chatId);
  if (!s) { s = { step:null, data:{}, albumId:null, images:[], selectedSizes:new Set(), messageIds:[], lastTs:null }; SESSIONS.set(chatId,s);}
  return s;
}

/* ------------------ Añadidos - utilidades seguras ------------------ */
async function safeJson(res) {
  try { return await res.json(); } catch (e) { return null; }
}
async function safeFetch(url, opts = {}, retries = 1) {
  try {
    const res = await fetch(url, opts);
    return res;
  } catch (err) {
    if (retries > 0) {
      console.warn(`[safeFetch] retrying ${url} due to ${err.message}`);
      return safeFetch(url, opts, retries - 1);
    }
    throw err;
  }
}
/* ------------------------------------------------------------------ */

async function tg(method, payload){
  const res = await fetch(`${TG_API}/${method}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  const json = await res.json().catch(()=>({}));
  if(!json.ok) throw new Error(`TG ${method} error: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function getFileUrl(file_id){
  const file = await tg('getFile',{ file_id });
  const path = file.result && file.result.file_path;
  if(!path) throw new Error('No file_path');
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

async function sendAdmin(msg){ if(!ADMIN) return; try{ await tg('sendMessage',{ chat_id:ADMIN,text:`⚠️ ${msg}`,parse_mode:'HTML' }); }catch{} }

// ---------- Handlers ----------

async function handleStart(chatId){
  await tg('sendMessage',{ chat_id:chatId, text:'Hola 👋 Soy el bot de catálogo Sofy. Enviame una foto (o un álbum) y te ayudo a cargarla.\n\nConsejo: si subís varias fotos de la misma prenda, mandalas como álbum para hacer un único producto con carrusel.' });
}

async function handleReset(chatId){
  // limpiar data.json
  try{
    const { items, sha } = await getDataJSON();
    // borrar imágenes del repo (si existen)
    for(const prod of items || []){
      for(const img of prod.images||[]){ 
        try{ await deleteFileFromRepo(`images/${img}`); }catch(e){}
      }
    }
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
  const ph = (msg.photo||[]).slice(-1)[0];
  if(!ph) return;
  const url = await getFileUrl(ph.file_id);
  const mgid = msg.media_group_id || null;

  // Generar nombre de archivo único
  const base = normalizeFilename(s.data.title || 'item') + '_' + Date.now();
  const index = (s.images.length||0) + 1;
  const fname = `${base}_${index}.jpg`;

  // Subir imagen al repo (persistente) y guardar solo el nombre en sesión
  try{
    await uploadFileToRepo(url,fname); // debe existir en github.js
    s.images.push(fname); // almaceno nombre final
  }catch(err){
    // si falla la subida, avisar admin y al usuario
    await sendAdmin(`Error subiendo imagen ${fname}: ${err.message}`);
    try{ await tg('sendMessage',{ chat_id:chatId, text:`❌ Error subiendo la imagen: ${err.message}` }); }catch(){}
    return;
  }

  if(mgid){
    // álbum
    if(!s.albumId || s.albumId!==mgid){
      s.albumId=mgid; s.selectedSizes=new Set(); s.data={}; s.step='album_confirm'; 
      await tg('sendMessage',{ chat_id:chatId,text:'📸 Detecté un álbum.\n¿Todas las fotos son de la misma prenda?',reply_markup:yesNoKeyboard('same_item') });
    } else {
      // ya estaba armando el álbum; no hacemos más mensajes por cada foto
    }
  }else{
    // foto individual: iniciamos flujo si no iniciado
    s.albumId=null; s.selectedSizes=new Set(); s.step='ask_title';
    await tg('sendMessage',{ chat_id:chatId,text:'📝 Decime el <b>nombre de la prenda</b>.',parse_mode:'HTML' });
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
      s.data.fabric=fab; s.step='sizes';
      await tg('editMessageText',{ chat_id:chatId,message_id:query.message.message_id,text:`Tela seleccionada: <b>${fab}</b>`,parse_mode:'HTML'});
      await tg('sendMessage',{ chat_id:chatId,text:'Elegí los <b>talles</b> (podés marcar varios) y tocá "Continuar ▶".',parse_mode:'HTML',reply_markup:sizesKeyboard(s.selectedSizes)});
      return;
    }
    if(data.startsWith('size|')){
      const sz = data.split('|')[1];
      if(s.selectedSizes.has(sz)) s.selectedSizes.delete(sz); else s.selectedSizes.add(sz);
      await tg('editMessageReplyMarkup',{ chat_id:chatId,message_id:query.message.message_id,reply_markup:sizesKeyboard(s.selectedSizes)});
      return;
    }
    if(data==='sizes_done'){
      s.data.sizes=new Set(Array.from(s.selectedSizes));
      s.step='price';
      await tg('sendMessage',{ chat_id:chatId,text:'💵 Ingresá el <b>precio</b> en ARS (solo números).',parse_mode:'HTML'}); return;
    }
    if(data.startsWith('yes|')||data.startsWith('no|')){
      const key=data.split('|')[1];
      if(key==='same_item'){
        if(data.startsWith('yes|')){
          s.step='ask_title';
          await tg('sendMessage',{ chat_id:chatId,text:'📝 Decime el <b>nombre de la prenda</b>.',parse_mode:'HTML'});
        }else{
          const imgs=[...s.images]; s.images=[]; s.albumId=null;
          for(const u of imgs){
            const temp = session(chatId);
            temp.images=[u]; temp.selectedSizes=new Set(); temp.data={}; temp.step='ask_title';
            await tg('sendMessage',{ chat_id:chatId,text:'📝 (Foto individual) nombre de la prenda:',parse_mode:'HTML'});
          }
        }
      }
      await tg('editMessageReplyMarkup',{ chat_id:chatId,message_id:query.message.message_id,reply_markup:{ inline_keyboard:[] } });
      return;
    }
  }catch(err){ await sendAdmin(`callback error: ${err.message}`); }finally{ try{ await tg('answerCallbackQuery',{ callback_query_id:query.id }); }catch{} }
}

async function handleText(msg){
  const chatId = msg.chat.id;
  const text = (msg.text||'').trim();
  const s = session(chatId);

  if(text==='/start') return handleStart(chatId);
  if(text==='/reset') return handleReset(chatId);

  if(text.startsWith('/eliminar')){
    const ref = msg.reply_to_message && msg.reply_to_message.text;
    const m = ref && ref.match(/\[ID:\s*(\d+)\]/);
    if(!m){ await tg('sendMessage',{ chat_id:chatId,text:'Para eliminar, respondé al mensaje de confirmación “✅ Subido … [ID: …]” con /eliminar.' }); return; }
    const id = m[1];
    try{ await fetch(DELETE_URL,{ method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY }, body:JSON.stringify({ id, hard:false }) });
      await tg('sendMessage',{ chat_id:chatId,text:`🗑️ Eliminado correctamente (ID: ${id}).` });
    }catch(err){ await tg('sendMessage',{ chat_id:chatId,text:`❌ Error eliminando: ${err.message}` }); await sendAdmin(`DELETE fail id=${id}: ${err.message}`); }
    return;
  }

  if(text==='/listo'){
    // Finalizar y actualizar data.json UNA SOLA VEZ
    try{
      // validaciones básicas
      if(!s.data.title) { await tg('sendMessage',{ chat_id:chatId,text:'Falta el título. Enviá el nombre de la prenda.' }); return; }
      if(!s.images || s.images.length===0){ await tg('sendMessage',{ chat_id:chatId,text:'No encontré imágenes para esta sesión. Enviá fotos primero.' }); return; }
      if(!s.data.price){ await tg('sendMessage',{ chat_id:chatId,text:'Falta el precio. Ingresá el precio en ARS.' }); s.step='price'; return; }

      // construir descripción y tags
      const desc = productDescription({ fabric:s.data.fabric, sizes:s.data.sizes, price:s.data.price });
      const tags = productTags({ fabric:s.data.fabric, sizes:s.data.sizes });

      // llamar al ADD_URL para crear el producto en tu backend
      const body = { title:s.data.title, description:desc, images:s.images, tags, price: s.data.price };
      let addJson = null;
      try{
        const res = await fetch(ADD_URL,{ method:'POST', headers:{ 'Content-Type':'application/json','x-api-key':API_KEY }, body:JSON.stringify(body) });
        addJson = await res.json();
        if(!addJson.ok) throw new Error(addJson.error||JSON.stringify(addJson));
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
        // no abortar: producto ya creado en ADD_URL, avisamos al admin
      }

      const conf = `✅ Subido\n${s.data.title}\n${desc}\n\n[ID: ${addJson.id || 'no-id'}]\n\nPara eliminar, respondé este mensaje con /eliminar`;
      await tg('sendMessage',{ chat_id:chatId,text:conf });

      // limpiar sesión
      s.step=null; s.data={}; s.images=[]; s.albumId=null; s.selectedSizes=new Set();
      return;
    }catch(err){
      await tg('sendMessage',{ chat_id:chatId,text:`❌ Error en /listo: ${err.message}` });
      await sendAdmin(`/listo error: ${err.message}`);
      return;
    }
  }

  if(s.step==='ask_title'){
    s.data.title=text; s.step='fabric';
    await tg('sendMessage',{ chat_id:chatId,text:'Elige la <b>tela</b>:',parse_mode:'HTML',reply_markup:fabricKeyboard(0)}); return;
  }

  if(s.step==='price'){
    const price = Number(text.replace(/[^\d]/g,'')||0); 
    if(!price){ await tg('sendMessage',{ chat_id:chatId,text:'Ingresá un número válido para el precio.' }); return; }
    s.data.price = price;

    // Informar al usuario que los datos se guardaron localmente y que debe usar /listo
    await tg('sendMessage',{ chat_id:chatId, text:'✔️ Precio guardado. Cuando termines de subir todas las fotos y configuraciones envía /listo para publicar todo.' });
    s.step=null;
    return;
  }

  await tg('sendMessage',{ chat_id:chatId,text:'Enviá una foto o un álbum para comenzar. /start' });
}

// ---------- Handler principal Netlify ----------

exports.handler = async(event)=>{
  if(event.httpMethod!=='POST') return { statusCode:200, body:'ok' };
  try{
    const update = JSON.parse(event.body||'{}');
    if(update.message){
      const msg = update.message;
      if(msg.photo) await handlePhoto(msg);
      else if(typeof msg.text==='string') await handleText(msg);
      else await tg('sendMessage',{ chat_id:msg.chat.id,text:'Mandá una foto o /start.' });
    } else if(update.callback_query){ await handleCallback(update.callback_query); }
    return { statusCode:200, body:JSON.stringify({ ok:true }) };
  }catch(err){ console.error('[tgWebhook] error',err); try{ await sendAdmin(`Webhook error: ${err.message}`); }catch{} return { statusCode:200, body:JSON.stringify({ ok:true }) }; }
};