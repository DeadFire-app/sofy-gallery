// netlify/functions/sendReceipt.js
// Send receipt to Telegram with maximum robustness
// Compatible with Netlify + Android frontend
const FormData = require('form-data');

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;

const TG_API_BASE = `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}`;

if (!TELEGRAM_RECEIPT_TOKEN || !TELEGRAM_RECEIPT_ID) {
  console.warn('[sendReceipt] Missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID');
}

// Helper: send message
async function tgSendMessage(chat_id, text) {
  try {
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
    });
    return await res.json().catch(() => ({ ok: false, error: 'Failed to parse Telegram response' }));
  } catch (err) {
    console.error('[tgSendMessage] Error:', err.message);
    return { ok: false, error: err.message };
  }
}

// Helper: safely parse JSON
function safeParseJson(str) {
  try { return JSON.parse(str); } 
  catch { return {}; }
}

// Extract multipart form-data (lightweight parser)
function parseMultipart(raw, boundary) {
  const result = { fields: {}, files: [] };
  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const nameMatch = part.match(/name="([^"]+)"/);
    const filenameMatch = part.match(/filename="([^"]+)"/);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const content = part.slice(idx + 4, part.lastIndexOf('\r\n'));
    if (filenameMatch) {
      const filename = filenameMatch[1] || 'file';
      result.files.push({ fieldName, filename, buffer: Buffer.from(content, 'binary') });
    } else {
      result.fields[fieldName] = content.trim();
    }
  }
  return result;
}

// Main handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  try {
    const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();

    let name = '', phone = '', email = '', filename = 'comprobante.jpg', fileBuffer = null;

    if (contentType.includes('application/json')) {
      const payload = safeParseJson(event.body || '{}');
      name = payload.name || '';
      phone = payload.phone || '';
      email = payload.email || '';
      filename = payload.filename || filename;

      if (payload.fileBase64) {
        fileBuffer = Buffer.from(payload.fileBase64, 'base64');
      } else if (payload.fileUrl) {
        const resp = await fetch(payload.fileUrl);
        if (!resp.ok) throw new Error(`Could not download file: ${resp.status}`);
        const arr = new Uint8Array(await resp.arrayBuffer());
        fileBuffer = Buffer.from(arr);
        filename = payload.filename || (payload.fileUrl.split('/').pop() || filename);
      } else {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No file provided in JSON' }) };
      }

    } else if (contentType.includes('multipart/form-data')) {
      if (!event.isBase64Encoded) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Expected base64 body for multipart/form-data' }) };

      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No boundary found for multipart/form-data' }) };

      const raw = Buffer.from(event.body, 'base64').toString('binary');
      const { fields, files } = parseMultipart(raw, boundaryMatch[1]);

      name = fields.name || '';
      phone = fields.phone || '';
      email = fields.email || '';

      if (files.length === 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No file detected in multipart body' }) };

      fileBuffer = files[0].buffer;
      filename = files[0].filename || filename;

    } else {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Unsupported content-type' }) };
    }

    // Safety check
    if (!fileBuffer) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'File buffer empty' }) };

    // Build FormData for Telegram
    const form = new FormData();
    form.append('chat_id', TELEGRAM_RECEIPT_ID);
    const caption = `📥 Nuevo comprobante recibido
<b>Nombre:</b> ${name || '-'}
<b>Teléfono:</b> ${phone || '-'}
<b>Email:</b> ${email || '-'}
<b>Origen:</b> Web
<b>Fecha:</b> ${(new Date()).toLocaleString()}`;
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('document', fileBuffer, { filename });

    // Send to Telegram
    const res = await fetch(`${TG_API_BASE}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
    const telegramRes = await res.json().catch(() => ({ ok: false, error: 'Failed to parse Telegram response' }));

    if (!telegramRes.ok) {
      await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error al enviar comprobante: ${JSON.stringify(telegramRes)}`);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: telegramRes }) };
    }

    // Confirm success to user/admin
    await tgSendMessage(TELEGRAM_RECEIPT_ID, `✅ Comprobante recibido correctamente.
Nombre: ${name || '-'}
Tel: ${phone || '-'}
Email: ${email || '-'}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Comprobante enviado' }) };

  } catch (err) {
    console.error('[sendReceipt] Fatal error:', err.message);
    try { await tgSendMessage(TELEGRAM_RECEIPT_ID, `❌ Error interno enviando comprobante: ${err.message}`); } catch {}
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};