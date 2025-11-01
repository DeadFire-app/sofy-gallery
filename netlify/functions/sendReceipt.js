// netlify/functions/sendReceipt.js
// Recibe comprobante (form-data) desde la web y lo envía al chat de Telegram definido en TELEGRAM_RECEIPT_ID
// Variables de entorno necesarias:
// TELEGRAM_RECEIPT_TOKEN, TELEGRAM_RECEIPT_ID

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;

const TG_API_BASE = `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}`;

const FormData = require('form-data');

// Helper: enviar mensaje simple
async function tgSendMessage(chat_id, text){
  const res = await fetch(`${TG_API_BASE}/sendMessage`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode:'HTML' })
  });
  return await res.json();
}

// Handler
exports.handler = async (event) => {
  if(event.httpMethod !== 'POST') return { statusCode:200, body: JSON.stringify({ ok:true }) };

  try{
    // Netlify Functions cuando recibe form-data normalmente entrega event.body como base64 y event.isBase64Encoded true.
    // La manera más simple y robusta: esperar que el cliente envíe JSON con:
    // { name, phone, email, filename, fileBase64 } OR enviar multipart/form-data y reenviarlo tal cual a Telegram.
    //
    // Vamos a soportar ambas:
    // - application/json: parsear base64 y construir form-data para Telegram.
    // - multipart/form-data: reenviar el body (Netlify no parsea automatically); sin embargo aquí usaremos event.body as base64
    //   and re-build a FormData.
    //
    // **Recomendación front-end**: enviar FormData con un input[type=file] (formData.append('receipt', file)) y fetch a esta function.
    // Netlify pasará event.body como base64 - debemos reconstruir el buffer.

    const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();

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
        // descargar desde URL
        const resp = await fetch(payload.fileUrl);
        const arr = new Uint8Array(await resp.arrayBuffer());
        fileBuffer = Buffer.from(arr);
        filename = payload.filename || (payload.fileUrl.split('/').pop() || filename);
      } else {
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'No file provided' }) };
      }
    } else {
      // multipart/form-data from browser: event.body is base64; we can try to parse it using a simple boundary-based extraction
      if(!event.isBase64Encoded) return { statusCode:400, body: JSON.stringify({ ok:false, error:'Expected base64 encoded body for multipart' }) };
      const raw = Buffer.from(event.body, 'base64');
      // Try to extract the file and fields in a lightweight way (works for typical browser FormData):
      // This is a best-effort parser — if falla, usar la opción application/json on the client side.
      const rawStr = raw.toString('binary');
      const headerMatch = (event.headers['content-type'] || event.headers['Content-Type'] || '').match(/boundary=(.*)$/);
      if(!headerMatch) return { statusCode:400, body: JSON.stringify({ ok:false, error:'No multipart boundary' }) };
      const boundary = headerMatch[1];
      const parts = rawStr.split(`--${boundary}`);
      for(const part of parts){
        if(part.indexOf('Content-Disposition:')===-1) continue;
        // Extract name
        const nameMatch = part.match(/name="([^"]+)"/);
        const filenameMatch = part.match(/filename="([^"]+)"/);
        const fieldName = nameMatch && nameMatch[1];
        if(filenameMatch){
          filename = filenameMatch[1];
          // extract binary after double CRLF
          const idx = part.indexOf('\r\n\r\n');
          if(idx!==-1){
            const fileContent = part.slice(idx+4, part.lastIndexOf('\r\n'));
            fileBuffer = Buffer.from(fileContent, 'binary');
          }
        } else {
          // field
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

    // Build FormData to send to Telegram sendDocument
    const form = new FormData();
    form.append('chat_id', TELEGRAM_RECEIPT_ID);
    const caption = `📥 Nuevo comprobante recibido\n\n<b>Nombre:</b> ${name || '-'}\n<b>Teléfono:</b> ${phone || '-'}\n<b>Email:</b> ${email || '-'}\n<b>Origen:</b> Web (sofymedina)\n<b>Fecha:</b> ${(new Date()).toLocaleString()}`;
    form.append('caption', caption);
    form.append('parse_mode','HTML');
    form.append('document', fileBuffer, { filename });

    // send to Telegram
    const res = await fetch(`${TG_API_BASE}/sendDocument`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders ? form.getHeaders() : {}
    });
    const telegramRes = await res.json();

    if(!telegramRes.ok){
      await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error al enviar comprobante: ${JSON.stringify(telegramRes)}`);
      return { statusCode:500, body: JSON.stringify({ ok:false, error: telegramRes }) };
    }

    // Also send a text message (optional) with structured data
    await tgSendMessage(TELEGRAM_RECEIPT_ID, `Comprobante enviado correctamente.\nNombre: ${name}\nTel: ${phone}\nEmail: ${email}`);

    return { statusCode:200, body: JSON.stringify({ ok:true, message:'Comprobante enviado' }) };

  }catch(err){
    console.error('[sendReceipt] err', err);
    return { statusCode:500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};