// netlify/functions/sendReceipt.js
// Final, robust sendReceipt for Netlify Functions
// - Validates name, phone, email (required)
// - Accepts JSON with base64 or fileUrl, and multipart/form-data (base64 incoming from Netlify)
// - Accepts any file type (jpg, png, pdf, etc.)
// - Retries Telegram calls, returns detailed diagnostics to ADMIN_CHAT_ID
// - Fallback: if sendDocument fails for images, tries sendPhoto
// - Protects against too-large files (>50 MB telegram limit)

const FormData = require('form-data');

const TELEGRAM_RECEIPT_TOKEN = process.env.TELEGRAM_RECEIPT_TOKEN;
const TELEGRAM_RECEIPT_ID = process.env.TELEGRAM_RECEIPT_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || TELEGRAM_RECEIPT_ID;

const TG_API_BASE = TELEGRAM_RECEIPT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_RECEIPT_TOKEN}` : null;
const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// Helpers
function now() { return new Date().toISOString(); }
function isLikelyImageByExt(fn){
  return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(fn || '');
}
function extFromFilename(fn){
  const m = (fn||'').match(/\.(\w+)(?:$|\?)/);
  return m ? m[1].toLowerCase() : '';
}
function safeTrim(s){ return (s||'').toString().trim(); }
function shortStr(s, n=400){ const t = typeof s==='string' ? s : JSON.stringify(s); return t.length>n ? t.slice(0,n)+'...(truncated)' : t; }

async function tgSendMessage(chatId, text) {
  if(!TG_API_BASE) return { ok:false, error:'TELEGRAM_RECEIPT_TOKEN not set' };
  try {
    const res = await fetch(`${TG_API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const txt = await res.text().catch(()=>'');
    try { return JSON.parse(txt); } catch { return { ok:false, error:'Telegram sendMessage non-JSON response', raw: txt, status: res.status }; }
  } catch (err) {
    return { ok:false, error: err.message };
  }
}

function safeParseJSON(str){
  try { return JSON.parse(str); } catch { return null; }
}

// Robust event.body parser for Netlify
function safeParseEventBody(event){
  const headers = event.headers || {};
  const contentTypeHeaderKey = Object.keys(headers).find(k => k.toLowerCase()==='content-type') || 'content-type';
  const contentType = (headers[contentTypeHeaderKey] || '').toLowerCase();
  if(!event.body) return { type:'empty', data:{} , contentType };

  // If netlify set isBase64Encoded true for multipart
  if(contentType.includes('application/json') || contentType.includes('application/vnd.api+json')){
    // try parse JSON safely
    const parsed = safeParseJSON(event.body);
    return { type:'json', data: parsed || {}, contentType };
  }

  // handle common mistake: text/plain but body is JSON
  if((contentType.includes('text/plain') || contentType.includes('application/octet-stream'))){
    const parsed = safeParseJSON(event.body);
    if(parsed) return { type:'json', data: parsed, contentType };
  }

  // multipart/form-data likely base64 encoded in Netlify
  if(contentType.includes('multipart/form-data')){
    return { type:'multipart', data: event.body, contentType };
  }

  // fallback: try JSON parse anyway
  const parsed = safeParseJSON(event.body);
  if(parsed) return { type:'json', data: parsed, contentType };

  return { type:'unknown', data: event.body, contentType };
}

// Lightweight multipart parser (works with Netlify base64->binary string)
// captures content-type per part if present
function parseMultipart(rawBinaryStr, boundary){
  const result = { fields: {}, files: [] };
  const parts = rawBinaryStr.split(`--${boundary}`);
  for(const p of parts){
    if(!p || !p.includes('Content-Disposition')) continue;
    // headers block end
    const idx = p.indexOf('\r\n\r\n');
    if(idx === -1) continue;
    const headerBlock = p.slice(0, idx);
    const content = p.slice(idx+4, p.lastIndexOf('\r\n'));
    // parse header dispositions
    const nameMatch = headerBlock.match(/name="([^"]+)"/);
    if(!nameMatch) continue;
    const fieldName = nameMatch[1];
    const filenameMatch = headerBlock.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i);
    if(filenameMatch){
      const filename = filenameMatch[1] || 'file';
      const ctype = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
      result.files.push({ fieldName, filename, contentType: ctype, buffer: Buffer.from(content, 'binary') });
    } else {
      result.fields[fieldName] = content.trim();
    }
  }
  return result;
}

// Post to Telegram with retries and verbose diagnostics
async function postToTelegramWithRetries(form, path='/sendDocument', retries=2){
  if(!TG_API_BASE) return { ok:false, error:'TELEGRAM_RECEIPT_TOKEN not set' };
  const url = `${TG_API_BASE}${path}`;
  for(let attempt=0; attempt<=retries; attempt++){
    try{
      const res = await fetch(url, { method:'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      const status = res.status;
      // capture headers
      const headers = {};
      try { res.headers.forEach((v,k)=> headers[k]=v); } catch {}
      const text = await res.text().catch(()=>'');
      // try parse JSON
      const parsed = safeParseJSON(text);
      if(parsed){
        if(parsed.ok) return { ok:true, parsed, status, headers, raw: text };
        else return { ok:false, parsed, status, headers, raw: text };
      }
      // non-json or empty body
      if(text === ''){
        // transient maybe - retry if attempts remain
        if(attempt < retries){
          await new Promise(r => setTimeout(r, 400 + attempt*300));
          continue;
        } else {
          return { ok:false, status, headers, raw: text, note:'empty response after retries' };
        }
      } else {
        // non-json non-empty text -> return with raw
        return { ok:false, status, headers, raw: text, note:'non-json response' };
      }
    } catch(err){
      if(attempt < retries){
        await new Promise(res => setTimeout(res, 400 + attempt*300));
        continue;
      }
      return { ok:false, error: err.message };
    }
  }
  return { ok:false, error: 'unknown' };
}

// Main handler
exports.handler = async (event) => {
  // Quick pre-checks
  if(!TELEGRAM_RECEIPT_TOKEN || !TELEGRAM_RECEIPT_ID){
    console.error('[sendReceipt] Missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID');
    return { statusCode:500, body: JSON.stringify({ ok:false, error:'Server misconfigured: missing TELEGRAM_RECEIPT_TOKEN or TELEGRAM_RECEIPT_ID' }) };
  }
  if(event.httpMethod !== 'POST') return { statusCode:200, body: JSON.stringify({ ok:true, message:'sendReceipt idle' }) };

  try {
    const parsed = safeParseEventBody(event);
    let name = '', phone = '', email = '', filename = 'file', fileBuffer = null, fileContentType = 'application/octet-stream';

    // Handle JSON payload
    if(parsed.type === 'json'){
      const payload = parsed.data || {};
      name = safeTrim(payload.name || '');
      phone = safeTrim(payload.phone || '');
      email = safeTrim(payload.email || '');
      if(!name || !phone || !email){
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'Faltan datos obligatorios: name, phone o email' }) };
      }
      filename = payload.filename || filename;
      if(payload.fileBase64){
        try {
          fileBuffer = Buffer.from(payload.fileBase64, 'base64');
        } catch(e){
          return { statusCode:400, body: JSON.stringify({ ok:false, error:'fileBase64 invalid' }) };
        }
      } else if(payload.fileUrl){
        // download remote file
        const resp = await fetch(payload.fileUrl);
        if(!resp.ok) return { statusCode:500, body: JSON.stringify({ ok:false, error:`Cannot download fileUrl: ${resp.status}` }) };
        const arr = new Uint8Array(await resp.arrayBuffer());
        fileBuffer = Buffer.from(arr);
        // try to guess filename from URL
        filename = payload.filename || (payload.fileUrl.split('/').pop() || filename);
        const ct = resp.headers.get('content-type');
        if(ct) fileContentType = ct;
      } else {
        return { statusCode:400, body: JSON.stringify({ ok:false, error:'No file provided in JSON' }) };
      }
    }

    // Handle multipart/form-data (Netlify provides base64 body)
    else if(parsed.type === 'multipart'){
      // need boundary from headers
      const headers = event.headers || {};
      const ctKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type') || 'content-type';
      const contentType = (headers[ctKey] || '').toLowerCase();
      const bm = contentType.match(/boundary=(.+)$/);
      if(!bm) return { statusCode:400, body: JSON.stringify({ ok:false, error:'No multipart boundary' }) };
      const boundary = bm[1];
      const rawBinary = Buffer.from(parsed.data, 'base64').toString('binary');
      const { fields, files } = parseMultipart(rawBinary, boundary);
      name = safeTrim(fields.name || '');
      phone = safeTrim(fields.phone || '');
      email = safeTrim(fields.email || '');
      if(!name || !phone || !email) return { statusCode:400, body: JSON.stringify({ ok:false, error:'Faltan datos obligatorios: name, phone o email' }) };
      if(!files || files.length === 0) return { statusCode:400, body: JSON.stringify({ ok:false, error:'No file detected in multipart' }) };
      const f = files[0];
      fileBuffer = f.buffer;
      filename = f.filename || filename;
      fileContentType = f.contentType || fileContentType;
    }

    else {
      return { statusCode:400, body: JSON.stringify({ ok:false, error:'Unsupported content-type' }) };
    }

    if(!fileBuffer) return { statusCode:400, body: JSON.stringify({ ok:false, error:'File buffer empty' }) };

    // Safety: Telegram limit check
    if(fileBuffer.length > TELEGRAM_MAX_BYTES){
      return { statusCode:413, body: JSON.stringify({ ok:false, error:'File too large for Telegram (over 50MB)' }) };
    }

    // Build caption
    const caption = `📥 Nuevo comprobante recibido
<b>Nombre:</b> ${name}
<b>Teléfono:</b> ${phone}
<b>Email:</b> ${email}
<b>Archivo:</b> ${filename}
<b>Fecha:</b> ${now()}`;

    // Build form for sendDocument
    const form = new FormData();
    form.append('chat_id', TELEGRAM_RECEIPT_ID);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('document', fileBuffer, { filename, contentType: fileContentType });

    // Attempt sendDocument with retries
    const docResult = await postToTelegramWithRetries(form, '/sendDocument', 2);

    if(docResult.ok){
      // success
      await tgSendMessage(ADMIN_CHAT_ID, `[sendReceipt] OK ${now()} - ${filename}`);
      return { statusCode:200, body: JSON.stringify({ ok:true, message:'Archivo enviado', detail: docResult.parsed || null }) };
    }

    // Build diagnostic detail
    const detail = {
      reason: docResult.error || docResult.note || 'sendDocument failed',
      status: docResult.status || null,
      headers: docResult.headers || null,
      raw_len: docResult.raw ? (docResult.raw.length||0) : 0,
      raw_snippet: docResult.raw ? shortStr(docResult.raw, 1000) : null
    };

    // Notify admin with detailed diagnostic
    try {
      await tgSendMessage(ADMIN_CHAT_ID,
        `<b>sendReceipt FAILED</b> ${now()}\nfile:${filename}\nreason:${detail.reason}\nstatus:${detail.status}\nraw_len:${detail.raw_len}`);
    } catch(e){ /* ignore admin notify fail */ }

    // If file looks like an image, try fallback sendPhoto
    if(isLikelyImageByExt(filename)){
      const formPhoto = new FormData();
      formPhoto.append('chat_id', TELEGRAM_RECEIPT_ID);
      formPhoto.append('caption', caption);
      formPhoto.append('photo', fileBuffer, { filename, contentType: fileContentType });
      const photoResult = await postToTelegramWithRetries(formPhoto, '/sendPhoto', 2);
      if(photoResult.ok){
        await tgSendMessage(ADMIN_CHAT_ID, `[sendReceipt fallback sendPhoto OK] ${now()} - ${filename}`);
        return { statusCode:200, body: JSON.stringify({ ok:true, message:'Archivo enviado (fallback sendPhoto)' }) };
      } else {
        // fallback failed, include info
        detail.fallback = {
          status: photoResult.status || null,
          raw_len: photoResult.raw ? (photoResult.raw.length||0) : 0,
          note: photoResult.note || photoResult.error || 'photo failed'
        };
        try { await tgSendMessage(ADMIN_CHAT_ID, `<b>sendReceipt fallback failed</b> ${now()} file:${filename} note:${detail.fallback.note}`); } catch {}
      }
    }

    // final: return error with diagnostics
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: detail }) };

  } catch (err) {
    console.error('[sendReceipt] fatal:', err);
    try { await tgSendMessage(ADMIN_CHAT_ID, `[sendReceipt fatal] ${err.message}`); } catch {}
    return { statusCode:500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};