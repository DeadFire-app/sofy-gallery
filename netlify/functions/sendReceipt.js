// netlify/functions/sendReceipt.js
// Recibe comprobante (form-data) desde la web y lo envía al chat de Telegram definido en TELEGRAM_RECEIPT_ID
// Variables de entorno necesarias:
// TELEGRAM_RECEIPT_TOKEN, TELEGRAM_RECEIPT_ID

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;

const TG_API_BASE = `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}`;

/* Intentamos usar form-data si está disponible (lo tenías en la versión original).
   Si Netlify no la provee o preferís no tener dependencias, el código también incluye un constructor multipart manual. */
let FormDataLib = null;
try { FormDataLib = require('form-data'); } catch(e) { FormDataLib = null; }

/* Helper: enviar mensaje simple */
async function tgSendMessage(chat_id, text){
  try{
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode:'HTML' })
    });
    return await res.json();
  }catch(err){
    console.error('[tgSendMessage] error', err);
    return { ok:false, error: err.message };
  }
}

/* Construcción simple de multipart/form-data en Buffer (no depende de librerías) */
function buildMultipartFormData(fields, file){
  const boundary = '----SofyBoundary' + Date.now();
  const chunks = [];

  function addString(str){
    chunks.push(Buffer.from(str, 'utf8'));
  }
  for(const key of Object.keys(fields || {})){
    addString(`--${boundary}\r\n`);
    addString(`Content-Disposition: form-data; name="${key}"\r\n\r\n`);
    addString(String(fields[key]) + '\r\n');
  }
  if(file && file.buffer){
    addString(`--${boundary}\r\n`);
    addString(`Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\n`);
    addString(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`);
    chunks.push(file.buffer);
    addString('\r\n');
  }
  addString(`--${boundary}--\r\n`);
  const body = Buffer.concat(chunks);
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return { body, contentType };
}

function getHeader(headers, key){
  if(!headers) return undefined;
  const hk = Object.keys(headers).find(h => h.toLowerCase() === key.toLowerCase());
  return hk ? headers[hk] : undefined;
}

// Handler
exports.handler = async (event) => {
  if(event.httpMethod !== 'POST') return { statusCode:200, body: JSON.stringify({ ok:true }) };

  try{
    const contentType = (getHeader(event.headers,'content-type') || '').toLowerCase();

    let name = '', phone = '', email = '', filename = 'comprobante.jpg', fileBuffer = null;

    if(contentType.includes('application/json')){
      const payload = JSON.parse(event.body || '{}');
      name = payload.name || '';
      phone = payload.phone || '';
      email = payload.email || '';
      filename = payload.filename || filename;
      if(payload.fileBase64){
        fileBuffer = Buffer.from(payload.fileBase64, 'base64');
      } else if(payload.fileUrl){
        const resp = await fetch(payload.fileUrl);
        const arr = new Uint8Array(await resp.arrayBuffer());
        fileBuffer = Buffer.from(arr);
        filename = payload.filename || (payload.fileUrl.split('/').pop() || filename);
      } else {
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'No file provided' }) };
      }
    } else {
      // multipart/form-data expected base64 (Netlify)
      if(!event.isBase64Encoded) return { statusCode:400, body: JSON.stringify({ ok:false, error:'Expected base64 encoded body for multipart' }) };
      const raw = Buffer.from(event.body, 'base64');
      // Lightweight parser (best-effort)
      const rawStr = raw.toString('binary');
      const headerMatch = (getHeader(event.headers,'content-type') || '').match(/boundary=(.*)$/);
      if(!headerMatch) return { statusCode:400, body: JSON.stringify({ ok:false, error:'No multipart boundary' }) };
      const boundary = headerMatch[1];
      const parts = rawStr.split(`--${boundary}`);
      for(const part of parts){
        if(part.indexOf('Content-Disposition:')===-1) continue;
        const nameMatch = part.match(/name="([^"]+)"/);
        const filenameMatch = part.match(/filename="([^"]+)"/);
        const fieldName = nameMatch && nameMatch[1];
        if(filenameMatch){
          filename = filenameMatch[1];
          const idx = part.indexOf('\r\n\r\n');
          if(idx!==-1){
            const fileContent = part.slice(idx+4, part.lastIndexOf('\r\n'));
            fileBuffer = Buffer.from(fileContent, 'binary');
          }
        } else {
          const idx = part.indexOf('\r\n\r\n');
          if(idx!==-1){
            const value = part.slice(idx+4, part.lastIndexOf('\r\n')).trim();
            if(fieldName==='name') name = value;
            if(fieldName==='phone') phone = value;
            if(fieldName==='email') email = value;
          }
        }
      }
      if(!fileBuffer) return { statusCode:400, body: JSON.stringify({ ok:false, error:'No file detected in multipart body — consider sending JSON with fileBase64' }) };
    }

    if(!TELEGRAM_RECEIPT_TOKEN || !TELEGRAM_RECEIPT_ID) return { statusCode:500, body: JSON.stringify({ ok:false, error:'Server misconfigured (missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID)' }) };

    // Preferir form-data library si existe (mantener compatibilidad con tu versión original),
    // si no existe, usamos builder manual.
    if(FormDataLib){
      const form = new FormDataLib();
      form.append('chat_id', TELEGRAM_RECEIPT_ID);
      form.append('document', fileBuffer, { filename });
      const caption = `📥 Nuevo comprobante recibido\n\n<b>Nombre:</b> ${name || '-'}\n<b>Teléfono:</b> ${phone || '-'}\n<b>Email:</b> ${email || '-'}\n<b>Fecha:</b> ${(new Date()).toLocaleString()}`;
      form.append('caption', caption);
      form.append('parse_mode','HTML');

      const res = await fetch(`${TG_API_BASE}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      const telegramRes = await safeJson(res) || {};
      if(!telegramRes.ok){
        await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error al enviar comprobante: ${JSON.stringify(telegramRes)}`);
        return { statusCode:500, body: JSON.stringify({ ok:false, error: telegramRes }) };
      }

    } else {
      // build manual multipart
      const caption = `📥 Nuevo comprobante recibido\n\n<b>Nombre:</b> ${name || '-'}\n<b>Teléfono:</b> ${phone || '-'}\n<b>Email:</b> ${email || '-'}\n<b>Fecha:</b> ${(new Date()).toLocaleString()}`;
      const fields = { chat_id: TELEGRAM_RECEIPT_ID, caption, parse_mode:'HTML' };
      const file = { fieldname: 'document', filename, contentType: 'application/octet-stream', buffer: fileBuffer };
      const multipart = buildMultipartFormData(fields, file);
      const res = await fetch(`${TG_API_BASE}/sendDocument`, {
        method: 'POST',
        headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.body.length) },
        body: multipart.body
      });
      const telegramRes = await safeJson(res) || {};
      if(!telegramRes.ok){
        await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error al enviar comprobante: ${JSON.stringify(telegramRes)}`);
        return { statusCode:500, body: JSON.stringify({ ok:false, error: telegramRes }) };
      }
    }

    // Also send a text message with structured data (optional)
    await tgSendMessage(TELEGRAM_RECEIPT_ID, `Comprobante enviado correctamente.\nNombre: ${name}\nTel: ${phone}\nEmail: ${email}`);

    return { statusCode:200, body: JSON.stringify({ ok:true, message:'Comprobante enviado' }) };

  }catch(err){
    console.error('[sendReceipt] err', err);
    return { statusCode:500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};