/* Telegram webhook (automatic diagnostic from image OCR)

What this does:

Receives images sent to the Telegram bot.

Downloads the image from Telegram.

Runs local OCR (tesseract.js) on the image to extract text.

Parses the extracted text for known GitHub / curl / API error patterns.

Replies back in Telegram with a short, concrete diagnosis like: "El fallo está en: token sin permission Contents: Read and write" or "El fallo está en: estás escribiendo a la rama incorrecta (master vs main)".


Environment variables required:

TELEGRAM_TOKEN    -> Your Telegram bot token (bot123:ABC...)

PORT (optional)   -> defaults to 3000


No external AI tokens are needed.

Dependencies (add to package.json):

axios

express

tesseract.js


Install example: npm install express axios tesseract.js

Deployment notes:

Works on Render, Railway, Heroku, or any node host. On serverless you may need a larger memory/timeout because tesseract OCR is CPU intensive.

Set webhook: curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" -d "url=https://<your-domain>/webhook"


Caveats:

OCR accuracy depends on image quality. If OCR fails to extract text, the bot will reply asking for a clearer screenshot.

This tries to infer the most likely cause from the extracted text; it's a heuristic-based diagnosis.


*/

const express = require('express'); const axios = require('axios'); const { createWorker } = require('tesseract.js');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN env var'); process.exit(1); }

const TELEGRAM_API = https://api.telegram.org/bot${TELEGRAM_TOKEN}; const TELEGRAM_FILE = https://api.telegram.org/file/bot${TELEGRAM_TOKEN};

const app = express(); app.use(express.json({ limit: '15mb' }));

async function sendTelegramMessage(chat_id, text, reply_to_message_id = null) { try { await axios.post(${TELEGRAM_API}/sendMessage, { chat_id, text, reply_to_message_id }); } catch (err) { console.error('Error sending Telegram message', err?.response?.data || err.message); } }

// Heuristic diagnosis based on text function diagnoseFromText(lowered) { if (!lowered || lowered.trim().length === 0) return null;

if (lowered.includes('not found') || lowered.includes('404')) { if (lowered.includes('x-accepted-github-permissions') || lowered.includes('metadata=read')) { return 'El fallo está en el token: GitHub aceptó solo permisos de metadata (metadata=read). Falta Contents: Read and write.'; } return 'El fallo está en permisos o ruta: 404 Not Found. Probá verificar que el token tenga acceso al repo y que la ruta/branch exista.'; }

if (lowered.includes('resource not accessible by integration')) { return 'El fallo está en el tipo de token: Resource not accessible by integration — probablemente estás usando un token de GitHub App sin permisos. Usá un PAT con Contents: Read and write.'; }

if (lowered.includes('sha does not match') || lowered.includes('sha')) { return 'El fallo está en el "sha": estás intentando actualizar un archivo y no se pasó la sha correcta. Para actualizar un archivo necesitás el sha actual.'; }

if (lowered.includes('content is too large') || lowered.includes('file too large')) { return 'El fallo está en el tamaño del archivo: el contenido es demasiado grande para la API de contenidos. Usá Releases, LFS o almacenamiento externo (S3).'; }

if (lowered.includes('403') || lowered.includes('forbidden')) { return 'El fallo está en autorización: 403 Forbidden. Verificá que el token no esté revocado y tenga los scopes correctos.'; }

if (lowered.includes('bad credentials') || lowered.includes('bad credential')) { return 'El fallo está en las credenciales: "Bad credentials" — el token es inválido o fue revocado.'; }

// Look for evidence of wrong branch if (lowered.includes('branch') && (lowered.includes('main') === false && lowered.includes('master') === false)) { return 'Posible fallo de branch: verificá que la rama enviada en el payload exista (main vs master).'; }

// Generic matches for common messages if (lowered.includes('not authorized') || lowered.includes('permission denied')) { return 'El fallo está relacionado con permisos: el token no tiene permiso para escribir en el repo.'; }

// If the text contains the header indicating accepted permissions if (lowered.includes('x-accepted-github-permissions')) { if (lowered.includes('contents=write')) { return 'El token tiene Contents: write — permisos correctos. El problema puede estar en branch, path, o en el payload (encoding).'; } return 'El token no tiene Contents: write — por eso falla. Añadí Contents: Read and write al token.'; }

// fallback: look for specific words if (lowered.includes('uploadfile fail') || lowered.includes('error subiendo imagen')) { return 'El mensaje indica que la subida falló. Revisá logs completos del backend: imprimí status y body del response de GitHub para diagnosticar exactamente.'; }

return null; }

async function runOCR(buffer) { const worker = createWorker({ // logger: m => console.log(m) }); try { await worker.load(); await worker.loadLanguage('eng'); await worker.initialize('eng'); const { data: { text } } = await worker.recognize(buffer); await worker.terminate(); return text; } catch (err) { try { await worker.terminate(); } catch(e){} throw err; } }

app.post('/webhook', async (req, res) => { try { const update = req.body; if (!update.message) return res.sendStatus(200);

const msg = update.message;
const chatId = msg.chat.id;

// If message contains photo -> do OCR and diagnose
if (msg.photo && msg.photo.length > 0) {
  await sendTelegramMessage(chatId, 'Recibí la imagen. Estoy analizando (OCR)...', msg.message_id);

  const photo = msg.photo[msg.photo.length - 1];
  const file_id = photo.file_id;

  // get file info
  const getFileResp = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id } });
  if (!getFileResp.data || !getFileResp.data.result) {
    await sendTelegramMessage(chatId, 'No pude obtener la ruta del archivo desde Telegram. Intentá enviar otra imagen.');
    return res.sendStatus(200);
  }

  const file_path = getFileResp.data.result.file_path;
  const fileUrl = `${TELEGRAM_FILE}/${file_path}`;

  // download image
  let fileResp;
  try {
    fileResp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 60000 });
  } catch (err) {
    console.error('Error descargando imagen', err?.message || err);
    await sendTelegramMessage(chatId, 'Error descargando la imagen desde Telegram. Intentá de nuevo.');
    return res.sendStatus(200);
  }

  const imageBuffer = Buffer.from(fileResp.data);

  // OCR
  let extractedText = '';
  try {
    extractedText = await runOCR(imageBuffer);
  } catch (err) {
    console.error('OCR error', err?.message || err);
    await sendTelegramMessage(chatId, 'No pude extraer texto de la imagen (OCR falló). Enviá una captura de pantalla clara del error.');
    return res.sendStatus(200);
  }

  const lowered = extractedText.toLowerCase();
  const diagnosis = diagnoseFromText(lowered);

  if (diagnosis) {
    await sendTelegramMessage(chatId, `Diagnóstico automático:

${diagnosis}, msg.message_id); } else { // If no direct diagnosis, return extracted text and suggestions const shortText = extractedText.length > 1000 ? extractedText.slice(0,1000) + '...' : extractedText; const reply = No pude identificar un patrón claro. Texto extraído (preview): ${shortText}

Sugerencia: pegá la salida completa del comando curl -v -X PUT ... o probá enviar una captura más legible.

Comandos recomendados:

1. Verificar acceso al repo: curl -i -H "Authorization: token TU_TOKEN" https://api.github.com/repos/DeadFire-app/sofy-gallery


2. Probar upload mínimo: curl -v -X PUT -H "Authorization: token TU_TOKEN" -d '{"message":"prueba","content":"dGVzdA==","branch":"main"}' https://api.github.com/repos/DeadFire-app/sofy-gallery/contents/test.txt`; await sendTelegramMessage(chatId, reply, msg.message_id); }

return res.sendStatus(200); }

// If message contains text -> parse and reply if (msg.text) { const diag = diagnoseFromText(msg.text.toLowerCase()); if (diag) { await sendTelegramMessage(chatId, Diagnóstico automático: ${diag}, msg.message_id); } else { await sendTelegramMessage(chatId, 'No pude detectar el error en ese texto. Pegá la salida completa del curl -v -X PUT ... (status + message).', msg.message_id); } return res.sendStatus(200); }

await sendTelegramMessage(chatId, 'Envíame una imagen con la captura del error o pegá el texto del error.'); res.sendStatus(200); } catch (err) { console.error('Webhook error', err?.response?.data || err.message); if (req.body?.message?.chat?.id) { await sendTelegramMessage(req.body.message.chat.id, 'Ocurrió un error interno procesando tu solicitud.'); } res.sendStatus(500); } });



app.get('/', (req, res) => res.send('Telegram OCR diagnostic webhook running'));

app.listen(PORT, () => console.log(Listening on ${PORT}));