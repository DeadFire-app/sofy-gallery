// netlify/functions/tgWebhook.js
// Bot Telegram (webhook). Soporta:
// - /start: saludo
// - /reset: diagnóstico y reporte a ADMIN_CHAT_ID
// - Álbumes (media_group_id) → pregunta si es la misma prenda; si sí, wizard (nombre, tela, talles, precio) y sube un producto con múltiples fotos.
// - Foto individual → wizard normal.
// - Confirmación: “✅ Subido … [ID: 123]”. Para borrar: responder ese mensaje con /eliminar.
// - /eliminar como reply: borra el producto en GitHub.
//
// Requiere env: BOT_TOKEN, ADD_URL, DELETE_URL, API_KEY, ADMIN_CHAT_ID

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADD_URL = process.env.ADD_URL;
const DELETE_URL = process.env.DELETE_URL;
const API_KEY = process.env.API_KEY;
const ADMIN = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) console.warn('[tgWebhook] Falta BOT_TOKEN');

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const FABRICS = [
  // base
  'algodón',
  'algodón peinado',
  'lino',
  'lino viscosa',
  'viscosa',
  'modal',
  'frisa',
  'rústico',
  'morley',
  'micromorley',
  'wafle',
  'fibrana',
  'crepe',
  'crep',            
  'tull',
  'broderie',
  'bremer',
  'lycra',
  'spandex',
  'gabardina',
  'bengalina',
  'jean',
  'engomado',
  'ecocuero',
  'satén',
  'saten',          
  'poliéster',
  'poliester',      
  'rayón',
  'rayon',          
  'hawaii',
  'CEY',
  'Jersey',
  'sastrero con spandex',
  'sastrero con lycra',
  'sastrero barbie',
  'cey lino',
  'lino morley con lycra',
  'microfibra con lycra',
  'crochet algodon con lycra',
  'crochet con lycra',
  'tylor con lycra',
  'poplin',
  'saten',
  'saten sastrero',
  'crep sastrero',
  'morley lino',
  'morley lino con lycra',
  'strech con lycra',
  'hilo Spandex',
  'tull con stras',
  'rompeviento',
  'fibrana',
  'hawaii con broderie',
  'algodon rustico',        
];

const SIZES = [
  '1 ( S )', '2 ( M )', '3 ( L )', '4 ( XL )', '5 ( XXL )', '6 ( XXXL )',
  '7', '8', '9', '10', '11', '12', 'unico',
  '36', '38', '40', '42', '44', '46',
  '48', '50', '52', '54', '56', '58'
];

const SESSIONS = new Map(); // { key(chatId): { step, data, albumId, images, messageIds, lastTs } }
// Nota: en serverless puede reiniciarse; funciona bien en flujos cortos.

function session(chatId) {
  let s = SESSIONS.get(chatId);
  if (!s) { s = { step:null, data:{}, albumId:null, images:[], selectedSizes:new Set(), messageIds:[] }; SESSIONS.set(chatId, s); }
  return s;
}

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json().catch(()=> ({}));
  if (!json.ok) throw new Error(`TG ${method} error: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function getFileUrl(file_id) {
  const file = await tg('getFile', { file_id });
  const path = file.result && file.result.file_path;
  if (!path) throw new Error('No file_path');
  return `${TG_FILE}/${path}`;
}

function fabricKeyboard(page=0) {
  const perRow = 2;
  const perPage = 12; // 6 filas * 2
  const start = page*perPage;
  const slice = FABRICS.slice(start, start+perPage);
  const rows = [];
  for (let i=0;i<slice.length;i+=perRow){
    rows.push(slice.slice(i,i+perRow).map(f => ({ text:f, callback_data:`fab|${f}` })));
  }
  const nav = [];
  if (start>0) nav.push({ text:'«', callback_data:`fabpage|${page-1}` });
  if (start+perPage<FABRICS.length) nav.push({ text:'»', callback_data:`fabpage|${page+1}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

function sizesKeyboard(selected=new Set()) {
  const perRow = 4;
  const rows = [];
  for (let i=0;i<SIZES.length;i+=perRow){
    const row = SIZES.slice(i,i+perRow).map(sz => ({
      text: selected.has(sz) ? `✅ ${sz}` : sz,
      callback_data: `size|${sz}`
    }));
    rows.push(row);
  }
  rows.push([{ text:'Continuar ▶', callback_data:'sizes_done' }]);
  return { inline_keyboard: rows };
}

function yesNoKeyboard(key) {
  return { inline_keyboard: [
    [{ text:'Sí', callback_data:`yes|${key}` }, { text:'No', callback_data:`no|${key}` }]
  ]};
}

async function addProductToSite(product) {
  const res = await fetch(ADD_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(product)
  });
  const json = await res.json().catch(()=> ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json && json.error ? json.error : `HTTP ${res.status}`);
  }
  return json.id;
}

async function deleteProductFromSite(id) {
  const res = await fetch(DELETE_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ id, hard:false })
  });
  const json = await res.json().catch(()=> ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json && json.error ? json.error : `HTTP ${res.status}`);
  }
  return true;
}

async function sendAdmin(msg) {
  if (!ADMIN) return;
  try { await tg('sendMessage', { chat_id: ADMIN, text: `⚠️ ${msg}`, parse_mode:'HTML' }); } catch {}
}

function productDescription({ fabric, sizes, price }) {
  const talla = Array.from(sizes||[]).join(', ');
  const ftxt = fabric ? (fabric[0].toUpperCase()+fabric.slice(1)) : '—';
  const p = (Number(price)||0).toLocaleString('es-AR');
  return `Tela: ${ftxt} · Talles: ${talla||'—'} · Precio: $${p} ARS`;
}

function productTags({ fabric, sizes }) {
  const s = Array.from(sizes||[]);
  return [
    ...(fabric ? [fabric.toLowerCase()] : []),
    ...s.map(x=>x.toLowerCase())
  ];
}

// --------- Handlers de flujos ---------

async function handleStart(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: 'Hola 👋 Soy el bot de catálogo Sofy. Enviame una foto (o un álbum) y te ayudo a cargarla.\n\nConsejo: si subís varias fotos de la misma prenda, mandalas como álbum para hacer un único producto con carrusel.',
  });
}

async function handleReset(chatId) {
  // Diagnóstico básico
  const checks = [];
  function ok(b, label){ checks.push(`${b?'✅':'❌'} ${label}`); return b; }

  const has = {
    BOT_TOKEN: !!BOT_TOKEN, ADD_URL: !!ADD_URL, DELETE_URL: !!DELETE_URL, API_KEY: !!API_KEY
  };
  ok(has.BOT_TOKEN, 'BOT_TOKEN');
  ok(has.ADD_URL, 'ADD_URL');
  ok(has.DELETE_URL, 'DELETE_URL');
  ok(has.API_KEY, 'API_KEY');

  // Ping ADD
  let addOk=false, delOk=false;
  try{
    const r = await fetch(ADD_URL, { method:'POST', headers:{'x-api-key':API_KEY,'Content-Type':'application/json'}, body:'{}'});
    addOk = r.status !== 503; // debe rechazar por validación, pero que responda
  }catch{}
  ok(addOk, 'Función addProduct responde');

  try{
    const r = await fetch(DELETE_URL, { method:'POST', headers:{'x-api-key':API_KEY,'Content-Type':'application/json'}, body:'{}'});
    delOk = r.status !== 503;
  }catch{}
  ok(delOk, 'Función deleteProduct responde');

  const txt = `🔧 RESET / DIAGNÓSTICO\n${checks.join('\n')}`;
  await tg('sendMessage', { chat_id: chatId, text: txt });
  if (!(has.BOT_TOKEN && has.ADD_URL && has.DELETE_URL && has.API_KEY)) {
    await sendAdmin(`RESET detectó variables faltantes. ${JSON.stringify(has)}`);
  }
}

// Foto (o álbum). En Telegram, los álbumes llegan con mismo media_group_id.
async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const s = session(chatId);

  // archivo más grande
  const ph = (msg.photo||[]).slice(-1)[0];
  if (!ph) return;

  const url = await getFileUrl(ph.file_id);
  const mgid = msg.media_group_id || null;

  if (mgid) {
    // agrupar álbum
    if (!s.albumId || s.albumId !== mgid) {
      s.albumId = mgid;
      s.images = [];
      s.selectedSizes = new Set();
      s.data = {};
      s.step = 'album_confirm';
      await tg('sendMessage', {
        chat_id: chatId,
        text: '📸 Detecté un álbum.\n¿Todas las fotos son de la misma prenda?',
        reply_markup: yesNoKeyboard('same_item')
      });
    }
    s.images.push(url);
  } else {
    // foto suelta: inicializa wizard para 1 imagen
    s.albumId = null;
    s.images = [url];
    s.selectedSizes = new Set();
    s.data = {};
    s.step = 'ask_title';
    await tg('sendMessage', { chat_id: chatId, text: '📝 Decime el <b>nombre de la prenda</b>.', parse_mode:'HTML' });
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const s = session(chatId);
  const data = query.data || '';
  try {
    if (data.startsWith('fabpage|')) {
      const page = Number(data.split('|')[1]||'0')||0;
      await tg('editMessageReplyMarkup', {
        chat_id: chatId, message_id: query.message.message_id,
        reply_markup: fabricKeyboard(page)
      });
      return;
    }
    if (data.startsWith('fab|')) {
      const fab = data.split('|')[1];
      s.data.fabric = fab;
      s.step = 'sizes';
      await tg('editMessageText', { chat_id: chatId, message_id: query.message.message_id, text:`Tela seleccionada: <b>${fab}</b>`, parse_mode:'HTML' });
      await tg('sendMessage', { chat_id: chatId, text:'Elegí los <b>talles</b> (podés marcar varios) y tocá "Continuar ▶".', parse_mode:'HTML', reply_markup: sizesKeyboard(s.selectedSizes) });
      return;
    }
    if (data.startsWith('size|')) {
      const sz = data.split('|')[1];
      if (s.selectedSizes.has(sz)) s.selectedSizes.delete(sz); else s.selectedSizes.add(sz);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: sizesKeyboard(s.selectedSizes) });
      return;
    }
    if (data === 'sizes_done') {
      s.data.sizes = new Set(Array.from(s.selectedSizes));
      s.step = 'price';
      await tg('sendMessage', { chat_id: chatId, text: '💵 Ingresá el <b>precio</b> en ARS (solo números).', parse_mode:'HTML' });
      return;
    }
    if (data.startsWith('yes|') || data.startsWith('no|')) {
      const key = data.split('|')[1];
      if (key === 'same_item') {
        if (data.startsWith('yes|')) {
          // álbum como un producto
          s.step = 'ask_title';
          await tg('sendMessage', { chat_id: chatId, text: '📝 Decime el <b>nombre de la prenda</b>.', parse_mode:'HTML' });
        } else {
          // tratar cada imagen como producto individual
          const imgs = [...s.images];
          s.images = []; s.albumId = null;
          for (const u of imgs) {
            const temp = session(chatId);
            temp.images = [u];
            temp.selectedSizes = new Set();
            temp.data = {};
            temp.step = 'ask_title';
            await tg('sendMessage', { chat_id: chatId, text: '📝 (Foto individual) nombre de la prenda:', parse_mode:'HTML' });
          }
        }
      }
      // ocultar teclado
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
      return;
    }
  } catch (err) {
    await sendAdmin(`callback error: ${err.message}`);
  } finally {
    // responder callback para evitar "loading..."
    try{ await tg('answerCallbackQuery', { callback_query_id: query.id }); } catch {}
  }
}

async function handleText(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text||'').trim();
  const s = session(chatId);

  // /start
  if (text === '/start') return handleStart(chatId);

  // /reset
  if (text === '/reset') return handleReset(chatId);

  // /eliminar como reply
  if (text.startsWith('/eliminar')) {
    const ref = msg.reply_to_message && msg.reply_to_message.text;
    const m = ref && ref.match(/\[ID:\s*(\d+)\]/);
    if (!m) {
      await tg('sendMessage', { chat_id: chatId, text: 'Para eliminar, respondé al mensaje de confirmación “✅ Subido … [ID: …]” con /eliminar.' });
      return;
    }
    const id = m[1];
    try{
      await deleteProductFromSite(id);
      await tg('sendMessage', { chat_id: chatId, text: `🗑️ Eliminado correctamente (ID: ${id}).` });
    }catch(err){
      await tg('sendMessage', { chat_id: chatId, text: `❌ Error eliminando: ${err.message}` });
      await sendAdmin(`DELETE fail id=${id}: ${err.message}`);
    }
    return;
  }

  // Wizard
  if (s.step === 'ask_title') {
    s.data.title = text;
    s.step = 'fabric';
    await tg('sendMessage', { chat_id: chatId, text: 'Elige la <b>tela</b>:', parse_mode:'HTML', reply_markup: fabricKeyboard(0) });
    return;
  }
  if (s.step === 'price') {
    const price = Number(text.replace(/[^\d]/g,'')||0);
    if (!price) {
      await tg('sendMessage', { chat_id: chatId, text: 'Ingresá un número válido para el precio.' });
      return;
    }
    s.data.price = price;

    // construir descripción/tags
    const desc = productDescription({ fabric:s.data.fabric, sizes:s.data.sizes, price: s.data.price });
    const tags = productTags({ fabric:s.data.fabric, sizes:s.data.sizes });

    // levantar imágenes (álbum o simple)
    const images = s.images && s.images.length ? s.images : [];
    try{
      const id = await addProductToSite({
        title: s.data.title,
        description: desc,
        images,
        tags,
        price
      });
      const conf = `✅ Subido\n${s.data.title}\n${desc}\n\n[ID: ${id}]\n\nPara eliminar, respondé este mensaje con /eliminar`;
      await tg('sendMessage', { chat_id: chatId, text: conf });

      // limpiar sesión
      s.step = null; s.data = {}; s.images = []; s.albumId = null; s.selectedSizes = new Set();
    }catch(err){
      await tg('sendMessage', { chat_id: chatId, text: `❌ Error subiendo: ${err.message}` });
      await sendAdmin(`ADD fail: ${err.message}`);
    }
    return;
  }

  // Si no hay estado y es texto suelto
  await tg('sendMessage', { chat_id: chatId, text: 'Enviá una foto o un álbum para comenzar. /start' });
}

// --------- Handler principal Netlify ---------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'ok' };
  }
  try {
    const update = JSON.parse(event.body || '{}');

    // Tipos
    if (update.message) {
      const msg = update.message;
      if (msg.photo) {
        await handlePhoto(msg);
      } else if (typeof msg.text === 'string') {
        await handleText(msg);
      } else {
        await tg('sendMessage', { chat_id: msg.chat.id, text: 'Mandá una foto o /start.' });
      }
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    return { statusCode: 200, body: JSON.stringify({ ok:true }) };
  } catch (err) {
    console.error('[tgWebhook] error', err);
    try { await sendAdmin(`Webhook error: ${err.message}`); } catch {}
    return { statusCode: 200, body: JSON.stringify({ ok:true }) }; // responder 200 para que Telegram no reintente infinito
  }
};