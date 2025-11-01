// netlify/functions/sendReceipt.js
// Versión final: robusta, acepta cualquier archivo, exige name, phone, email
// Variables de entorno necesarias:
// TELEGRAM_RECEIPT_TOKEN, TELEGRAM_RECEIPT_ID

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;

const TG_API_BASE = `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}`;
const FormData = require('form-data');

async function tgSendMessage(chat_id, text) {
  try {
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
    });
    const data = await res.json().catch(() => null);
    return data;
  } catch (err) {
    console.error('[tgSendMessage] error', err);
    return null;
  }
}

exports.handler = async (event) => {
  try {
    if (!TELEGRAM_RECEIPT_TOKEN || !TELEGRAM_RECEIPT_ID) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server misconfigured: missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID' }) };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'SendReceipt ready' }) };
    }

    let name = '', phone = '', email = '', filename = 'file.dat', fileBuffer = null;

    const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();

    if (contentType.includes('application/json')) {
      // JSON con base64
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch { payload = {}; }
      name = (payload.name || '').trim();
      phone = (payload.phone || '').trim();
      email = (payload.email || '').trim();
      filename = payload.filename || filename;

      if (!payload.fileBase64 && !payload.fileUrl) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No file provided' }) };
      }

      if (payload.fileBase64) {
        fileBuffer = Buffer.from(payload.fileBase64, 'base64');
      } else if (payload.fileUrl) {
        const resp = await fetch(payload.fileUrl);
        if (!resp.ok) throw new Error(`Cannot fetch file: ${resp.status}`);
        const arr = new Uint8Array(await resp.arrayBuffer());
        fileBuffer = Buffer.from(arr);
        filename = payload.filename || (payload.fileUrl.split('/').pop() || filename);
      }

    } else if (contentType.includes('multipart/form-data')) {
      if (!event.isBase64Encoded) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Expected base64 encoded body for multipart/form-data' }) };
      }

      const raw = Buffer.from(event.body, 'base64');
      const headerMatch = (event.headers['content-type'] || event.headers['Content-Type'] || '').match(/boundary=(.*)$/);
      if (!headerMatch) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No multipart boundary' }) };
      const boundary = headerMatch[1];
      const parts = raw.toString('binary').split(`--${boundary}`);

      for (const part of parts) {
        if (part.indexOf('Content-Disposition:') === -1) continue;
        const nameMatch = part.match(/name="([^"]+)"/);
        const filenameMatch = part.match(/filename="([^"]+)"/);
        const fieldName = nameMatch && nameMatch[1];

        if (filenameMatch) {
          filename = filenameMatch[1];
          const idx = part.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const fileContent = part.slice(idx + 4, part.lastIndexOf('\r\n'));
            fileBuffer = Buffer.from(fileContent, 'binary');
          }
        } else {
          const idx = part.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const value = part.slice(idx + 4, part.lastIndexOf('\r\n')).trim();
            if (fieldName === 'name') name = value;
            if (fieldName === 'phone') phone = value;
            if (fieldName === 'email') email = value;
          }
        }
      }

      if (!fileBuffer) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No file detected in multipart body — use JSON with fileBase64 if fails' }) };

    } else {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Unsupported content-type' }) };
    }

    // Validaciones obligatorias
    if (!name || !phone || !email) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Faltan datos obligatorios: name, phone o email' }) };
    }

    // Construir FormData para Telegram
    const form = new FormData();
    form.append('chat_id', TELEGRAM_RECEIPT_ID);
    const caption = `📥 Nuevo comprobante recibido\n\n<b>Nombre:</b> ${name}\n<b>Teléfono:</b> ${phone}\n<b>Email:</b> ${email}\n<b>Origen:</b> Web\n<b>Fecha:</b> ${(new Date()).toLocaleString()}`;
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('document', fileBuffer, { filename });

    // Enviar a Telegram
    const res = await fetch(`${TG_API_BASE}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
    let telegramRes;
    try { telegramRes = await res.json(); } catch { telegramRes = { ok: false, error: 'Telegram response not JSON', raw: await res.text() }; }

    if (!telegramRes.ok) {
      await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error enviando comprobante: ${JSON.stringify(telegramRes)}`);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: telegramRes }) };
    }

    await tgSendMessage(TELEGRAM_RECEIPT_ID, `✔️ Comprobante enviado correctamente.\nNombre: ${name}\nTel: ${phone}\nEmail: ${email}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Comprobante enviado correctamente' }) };

  } catch (err) {
    console.error('[sendReceipt] error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message || err.toString() }) };
  }
};