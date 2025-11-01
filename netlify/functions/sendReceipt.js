// netlify/functions/sendReceipt.js
const FormData = require('form-data');

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;

const TG_API_BASE = `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}`;

if (!TELEGRAM_RECEIPT_TOKEN || !TELEGRAM_RECEIPT_ID) {
  console.warn('[sendReceipt] Missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID');
}

// Helper seguro para enviar mensajes a Telegram
async function tgSendMessage(chat_id, text){
  try {
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode:'HTML' })
    });
    const textResp = await res.text();
    try { return JSON.parse(textResp); } 
    catch { return { ok:false, error:'Telegram response not JSON', raw:textResp }; }
  } catch(err){
    console.error('[tgSendMessage] Error:', err.message);
    return { ok:false,error:err.message };
  }
}

// Parseo seguro de event.body
function safeParseEventBody(event){
  const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  if (!event.body) return { type:'empty', data:{} };

  if (contentType.includes('application/json')){
    try { return { type:'json', data: JSON.parse(event.body) }; }
    catch { return { type:'json', data:{} }; }
  }

  if (contentType.includes('multipart/form-data') && event.isBase64Encoded){
    return { type:'multipart', data:event.body };
  }

  return { type:'unknown', data:{} };
}

// Parser ligero de multipart/form-data
function parseMultipart(raw, boundary){
  const result = { fields:{}, files:[] };
  const parts = raw.split(`--${boundary}`);
  for(const part of parts){
    if(!part.includes('Content-Disposition')) continue;
    const nameMatch = part.match(/name="([^"]+)"/);
    const filenameMatch = part.match(/filename="([^"]+)"/);
    if(!nameMatch) continue;
    const fieldName = nameMatch[1];
    const idx = part.indexOf('\r\n\r\n');
    if(idx===-1) continue;
    const content = part.slice(idx+4, part.lastIndexOf('\r\n'));
    if(filenameMatch){
      const filename = filenameMatch[1] || 'file';
      result.files.push({ fieldName, filename, buffer: Buffer.from(content,'binary') });
    } else {
      result.fields[fieldName] = content.trim();
    }
  }
  return result;
}

// Handler principal
exports.handler = async(event)=>{
  if(event.httpMethod!=='POST') return { statusCode:200, body: JSON.stringify({ok:true}) };

  try {
    const parsed = safeParseEventBody(event);
    let filename='archivo', fileBuffer=null, name='', phone='', email='';

    // --- JSON input ---
    if(parsed.type==='json'){
      const payload = parsed.data;
      name = (payload.name||'').trim();
      phone = (payload.phone||'').trim();
      email = (payload.email||'').trim();

      if(!name || !phone || !email){
        return { statusCode:400, body: JSON.stringify({ok:false,error:'Faltan datos obligatorios: name, phone o email'}) };
      }

      filename = payload.filename || 'archivo';
      if(payload.fileBase64) fileBuffer = Buffer.from(payload.fileBase64,'base64');
      else if(payload.fileUrl){
        const resp = await fetch(payload.fileUrl);
        if(!resp.ok) throw new Error(`Cannot download file: ${resp.status}`);
        const arr = new Uint8Array(await resp.arrayBuffer());
        fileBuffer = Buffer.from(arr);
        filename = payload.filename || (payload.fileUrl.split('/').pop() || filename);
      } else {
        return { statusCode:400, body: JSON.stringify({ok:false,error:'No file provided in JSON'}) };
      }
    }

    // --- multipart/form-data ---
    else if(parsed.type==='multipart'){
      const raw = Buffer.from(parsed.data,'base64').toString('binary');
      const boundaryMatch = (event.headers['content-type'] || event.headers['Content-Type']).match(/boundary=(.+)$/);
      if(!boundaryMatch) return { statusCode:400, body: JSON.stringify({ok:false,error:'No multipart boundary'}) };
      const { fields, files } = parseMultipart(raw,boundaryMatch[1]);

      name = (fields.name||'').trim();
      phone = (fields.phone||'').trim();
      email = (fields.email||'').trim();

      if(!name || !phone || !email){
        return { statusCode:400, body: JSON.stringify({ok:false,error:'Faltan datos obligatorios: name, phone o email'}) };
      }

      if(files.length===0) return { statusCode:400, body: JSON.stringify({ok:false,error:'No file detected'}) };
      fileBuffer = files[0].buffer;
      filename = files[0].filename || 'archivo';
    }

    else return { statusCode:400, body: JSON.stringify({ok:false,error:'Unsupported content-type'}) };

    if(!fileBuffer) return { statusCode:400, body: JSON.stringify({ok:false,error:'File buffer empty'}) };

    // --- FormData para Telegram ---
    const form = new FormData();
    form.append('chat_id', TELEGRAM_RECEIPT_ID);
    form.append('caption', `📥 Nuevo comprobante recibido
<b>Nombre:</b> ${name}
<b>Teléfono:</b> ${phone}
<b>Email:</b> ${email}
<b>Nombre archivo:</b> ${filename}
<b>Fecha:</b> ${(new Date()).toLocaleString()}`);
    form.append('parse_mode','HTML');
    form.append('document', fileBuffer, { filename });

    // --- Enviar a Telegram ---
    let telegramRes;
    try {
      const res = await fetch(`${TG_API_BASE}/sendDocument`, { method:'POST', body:form, headers:form.getHeaders ? form.getHeaders() : {} });
      const text = await res.text();
      try { telegramRes = JSON.parse(text); } 
      catch { telegramRes = { ok:false, error:'Telegram response not JSON', raw:text }; }
    }
    catch(err){
      telegramRes = { ok:false, error: err.message };
    }

    if(!telegramRes.ok){
      await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error enviando comprobante: ${JSON.stringify(telegramRes)}`);
      return { statusCode:500, body: JSON.stringify({ok:false,error:telegramRes}) };
    }

    await tgSendMessage(TELEGRAM_RECEIPT_ID, `✅ Comprobante recibido correctamente.
Nombre: ${name}
Teléfono: ${phone}
Email: ${email}
Archivo: ${filename}`);

    return { statusCode:200, body: JSON.stringify({ok:true,message:'Comprobante enviado'}) };
  }
  catch(err){
    console.error('[sendReceipt] Fatal:', err.message);
    try{ await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error interno: ${err.message}`); } catch {}
    return { statusCode:500, body: JSON.stringify({ok:false,error:err.message}) };
  }
};