// netlify/functions/sendReceipt.js
// Recibe comprobante (form-data o JSON) y lo envía al chat de Telegram definido en TELEGRAM_RECEIPT_ID
// Variables de entorno necesarias:
// TELEGRAM_RECEIPT_TOKEN, TELEGRAM_RECEIPT_ID

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;

const TG_API_BASE = `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}`;

const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default:fetch})=>fetch(...args));

// Helper: enviar mensaje simple
async function tgSendMessage(chat_id, text){
  try {
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode:'HTML' })
    });
    const resText = await res.text();
    try { return JSON.parse(resText); } 
    catch { return { ok:false, error:'Telegram response not JSON', raw: resText }; }
  } catch(err){ return { ok:false, error: err.message }; }
}

// Helper: validar campos obligatorios
function validateFields(obj){
  if(!obj.name || !obj.phone || !obj.email) return false;
  return true;
}

// Handler
exports.handler = async (event) => {
  if(event.httpMethod !== 'POST') 
    return { statusCode:200, body: JSON.stringify({ ok:true }) };

  if(!TELEGRAM_RECEIPT_TOKEN || !TELEGRAM_RECEIPT_ID){
    return { statusCode:500, body: JSON.stringify({ ok:false, error:'Server misconfigured: missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID' }) };
  }

  try{
    const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();

    let name='', phone='', email='', filename='comprobante.bin', fileBuffer=null;

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

      if(!validateFields({ name, phone, email }))
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'Faltan datos obligatorios: name, phone o email' }) };

    } else if(contentType.includes('multipart/form-data')){
      if(!event.isBase64Encoded) return { statusCode:400, body: JSON.stringify({ ok:false, error:'Expected base64 encoded body for multipart' }) };

      const raw = Buffer.from(event.body, 'base64');
      const rawStr = raw.toString('binary');
      const headerMatch = (event.headers['content-type'] || event.headers['Content-Type'] || '').match(/boundary=(.*)$/);
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
        } else if(fieldName){
          const idx = part.indexOf('\r\n\r\n');
          if(idx!==-1){
            const value = part.slice(idx+4, part.lastIndexOf('\r\n')).trim();
            if(fieldName==='name') name=value;
            if(fieldName==='phone') phone=value;
            if(fieldName==='email') email=value;
          }
        }
      }

      if(!fileBuffer) return { statusCode:400, body: JSON.stringify({ ok:false, error:'No file detected in multipart body — use JSON with fileBase64 or fileUrl' }) };
      if(!validateFields({ name, phone, email }))
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'Faltan datos obligatorios: name, phone o email' }) };

    } else {
      return { statusCode:400, body: JSON.stringify({ ok:false, error:'Unsupported content-type' }) };
    }

    // Construir FormData para Telegram
    const form = new FormData();
    form.append('chat_id', TELEGRAM_RECEIPT_ID);
    const caption = `📥 Nuevo comprobante recibido\n\n<b>Nombre:</b> ${name}\n<b>Teléfono:</b> ${phone}\n<b>Email:</b> ${email}\n<b>Fecha:</b> ${(new Date()).toLocaleString()}`;
    form.append('caption', caption);
    form.append('parse_mode','HTML');
    form.append('document', fileBuffer, { filename });

    const res = await fetch(`${TG_API_BASE}/sendDocument`, {
      method:'POST',
      body: form,
      headers: form.getHeaders ? form.getHeaders() : {}
    });

    const resText = await res.text();
    let telegramRes;
    try { telegramRes = JSON.parse(resText); } 
    catch { telegramRes = { ok:false, error:'Telegram response not JSON', raw: resText }; }

    if(!telegramRes.ok){
      await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error enviando comprobante: ${JSON.stringify(telegramRes)}`);
      return { statusCode:500, body: JSON.stringify({ ok:false, error: telegramRes }) };
    }

    // Mensaje adicional
    await tgSendMessage(TELEGRAM_RECEIPT_ID, `✔️ Comprobante enviado correctamente.\nNombre: ${name}\nTel: ${phone}\nEmail: ${email}`);

    return { statusCode:200, body: JSON.stringify({ ok:true, message:'Comprobante enviado' }) };

  } catch(err){
    console.error('[sendReceipt] err', err);
    return { statusCode:500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};