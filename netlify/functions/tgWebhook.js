// netlify/functions/tgWebhook.js
// Sofy Bot — versión final robusta (Node 18+, fetch nativo)
//
// Requisitos de ENV en Netlify (Site settings → Environment variables):
// BOT_TOKEN, API_KEY, ADD_URL, DELETE_URL
//  (si addProduct escribe en GitHub: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, DATA_PATH, GITHUB_BRANCH)
//
// Características:
// - /start -> saludo
// - FOTO -> pide NOMBRE -> Tela (inline) -> Talles (multi inline) -> Precio (texto) -> POST a ADD_URL
// - /eliminar usado como respuesta a TU foto -> POST a DELETE_URL con { image }
// - Nunca devuelve 400 a Telegram (siempre 200 OK) para evitar errores de webhook.
// - Manejo de errores con console.error para verlos en Netlify → Functions → tgWebhook → Logs

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const TELEGRAM_FILE = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}`;

const ADD_URL    = process.env.ADD_URL;
const DELETE_URL = process.env.DELETE_URL;
const API_KEY    = process.env.API_KEY;

// Telas (extendidas)
const FABRICS = [
  "Algodón","Algodón peinado","Lino","Viscosa","Modal","Rayón","Acetato","Oxford","Poplina","Muselina","Voile",
  "Fibrana","Rústico","Broderie","Lycra","Spandex","Morley","Micromorley","Jersey","Elastano","Wafle",
  "Microfibra","Dry-fit","Técnica","Supplex","Acrílico","Friza","Polar","Pañolén","Lana","Bremer",
  "Satinado","Crepé","Velvet (terciopelo)","Chiffón","Organza","Encaje","Tull","Hawaii",
  "Gabardina","Bengalina","Jean / Denim","Twill","Canvas","Ecocuero","Cuero ecológico","Engomado"
];
// Talles
const SIZES = ["XS","S","M","L","XL","XXL","XXXL","Único"];

// Memoria simple en RAM (se resetea con cada redeploy/idle)
const sessions = new Map();

// ===== Helpers de respuesta HTTP =====
const ok = (body={ ok:true }) => ({ statusCode: 200, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });

// ===== Helpers Telegram =====
async function tg(method, payload) {
  try {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error(`[tg ${method}]`, e);
    return { ok:false };
  }
}
const sendMessage = (chat_id, text, extra={}) => tg("sendMessage", { chat_id, text, ...extra });
const answerCb    = (callback_query_id, text="") => tg("answerCallbackQuery", { callback_query_id, text });
const editText    = (chat_id, message_id, text, extra={}) => tg("editMessageText", { chat_id, message_id, text, ...extra });
const editMarkup  = (chat_id, message_id, reply_markup) => tg("editMessageReplyMarkup", { chat_id, message_id, reply_markup });

async function getFileUrl(file_id){
  try{
    const r = await fetch(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    const j = await r.json();
    if (j.ok && j.result?.file_path) return `${TELEGRAM_FILE}/${j.result.file_path}`;
  }catch(e){ console.error("[getFileUrl]", e); }
  return "";
}

// ===== Keyboards =====
function fabricKeyboard(){
  // 3 columnas por fila
  const rows = [];
  for (let i=0;i<FABRICS.length;i+=3){
    rows.push(FABRICS.slice(i,i+3).map(label => ({ text: label, callback_data: `FAB:${label}` })));
  }
  return { inline_keyboard: rows };
}
function sizesKeyboard(selected = []){
  const S = new Set(selected);
  const rows = [];
  for (let i=0;i<SIZES.length;i+=4){
    rows.push(SIZES.slice(i,i+4).map(sz => ({
      text: `${S.has(sz) ? "✅ " : ""}${sz}`,
      callback_data: `SIZE:${sz}`
    })));
  }
  rows.push([{ text:"❌ Cancelar", callback_data:"CANCEL" }, { text:"✅ Continuar", callback_data:"NEXT" }]);
  return { inline_keyboard: rows };
}

// ===== Parsers =====
function parsePrice(raw=""){
  const s = String(raw).replace(/[^\d.,]/g,"").replace(/\./g,"").replace(",",".");
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n*100)/100;
}

// ===== Handler principal =====
exports.handler = async (event) => {
  // Telegram debería usar POST, pero si envía otra cosa… nunca 400.
  if (event.httpMethod !== "POST") return ok({ note:"non-POST ignored" });

  let update = {};
  try { update = JSON.parse(event.body || "{}"); }
  catch (e) { console.error("[JSON parse]", e, "body:", event.body); return ok({ note:"bad json ignored" }); }

  try {
    // ---- CALLBACK QUERY (botones inline) ----
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const msgId  = cq.message?.message_id;
      const data   = cq.data || "";
      const sess   = sessions.get(chatId) || {};

      // Siempre contestar callback para quitar spinner
      try { await answerCb(cq.id); } catch {}

      if (!chatId || !msgId) return ok();

      // Tela seleccionada
      if (data.startsWith("FAB:")){
        const fabric = data.slice(4);
        if (!FABRICS.includes(fabric)) return ok();
        sess.fabric = fabric;
        sess.step   = "SIZES";
        sessions.set(chatId, sess);
        await editText(chatId, msgId, `🧵 Tela: *${fabric}*\nAhora elegí los talles (podés varias)`, { parse_mode:"Markdown" });
        await editMarkup(chatId, msgId, sizesKeyboard(sess.sizes || []));
        return ok();
      }

      // Toggle de talles
      if (data.startsWith("SIZE:")){
        const sz = data.slice(5);
        if (!SIZES.includes(sz)) return ok();
        const set = new Set(sess.sizes || []);
        set.has(sz) ? set.delete(sz) : set.add(sz);
        sess.sizes = Array.from(set);
        sessions.set(chatId, sess);
        await editMarkup(chatId, msgId, sizesKeyboard(sess.sizes));
        return ok();
      }

      // Continuar a precio
      if (data === "NEXT"){
        if (!sess.fabric) { await answerCb(cq.id, "Elegí una tela primero"); return ok(); }
        if (!sess.sizes || sess.sizes.length===0) { await answerCb(cq.id, "Seleccioná al menos un talle"); return ok(); }
        sess.step = "PRICE";
        sessions.set(chatId, sess);
        await editText(chatId, msgId,
          `✅ *Nombre:* ${sess.title || "-"}\n✅ *Tela:* ${sess.fabric}\n✅ *Talles:* ${sess.sizes.join(", ")}\n\nEscribí el *precio* en ARS (solo número, ej: 25999)`,
          { parse_mode:"Markdown" }
        );
        await editMarkup(chatId, msgId, { inline_keyboard: [] });
        return ok();
      }

      // Cancelar
      if (data === "CANCEL"){
        sessions.delete(chatId);
        await editText(chatId, msgId, "Operación cancelada, Mar. 💫");
        await editMarkup(chatId, msgId, { inline_keyboard: [] });
        return ok();
      }

      return ok();
    }

    // ---- MENSAJES ----
    const msg = update.message || update.edited_message;
    if (!msg) return ok({ note:"no message" });
    const chatId = msg.chat?.id;

    // /start
    if (msg.text && msg.text.trim().startsWith("/start")){
      await sendMessage(chatId,
        "Hola Mar 👋\nMandame una *foto* para cargar un producto.\n" +
        "Flujo: *Nombre* → *Tela* → *Talles* → *Precio* → Subir ✅\n" +
        "Para borrar: respondé a tu *propia* foto con /eliminar.",
        { parse_mode:"Markdown" }
      );
      return ok();
    }

    // /eliminar (debe ser reply a TU foto)
    if (msg.text && msg.text.trim().split(/\s+/)[0].toLowerCase() === "/eliminar"){
      const replied = msg.reply_to_message;
      if (!replied) { await sendMessage(chatId,"Usá /eliminar *respondiendo a tu foto*.",{ parse_mode:"Markdown" }); return ok(); }
      if (!replied.photo) { await sendMessage(chatId,"Ese mensaje no tiene foto, Mar."); return ok(); }
      if ((replied.from?.id) !== msg.from?.id) { await sendMessage(chatId,"Tiene que ser tu *propio* mensaje con la foto, Mar.",{ parse_mode:"Markdown" }); return ok(); }

      try {
        const largest = replied.photo.reduce((a,b)=> (a.file_size||0)>(b.file_size||0)?a:b);
        const imageUrl = await getFileUrl(largest.file_id);
        if (!imageUrl){ await sendMessage(chatId,"No pude obtener la imagen, Mar."); return ok(); }

        const delRes = await fetch(DELETE_URL, {
          method: "POST",
          headers: { "Content-Type":"application/json", "x-api-key": API_KEY },
          body: JSON.stringify({ image: imageUrl })
        }).then(r=>r.json()).catch(e=>({ ok:false, error:String(e) }));

        if (delRes?.ok && delRes.removedCount > 0) await sendMessage(chatId, `🗑️ Listo, Mar. Eliminé ${delRes.removedCount} elemento(s).`);
        else await sendMessage(chatId, "No encontré esa imagen en el catálogo, Mar.");

      } catch (e) {
        console.error("[/eliminar]", e);
        await sendMessage(chatId,"Error al eliminar en el servidor.");
      }
      return ok();
    }

    // FOTO: iniciar flujo
    if (msg.photo){
      try{
        const largest = msg.photo.reduce((a,b)=> (a.file_size||0)>(b.file_size||0)?a:b);
        const imageUrl = await getFileUrl(largest.file_id);
        sessions.set(chatId, { step:"NAME", imageUrl, sizes:[] });
        await sendMessage(chatId, "📛 ¿Nombre de la prenda?", { reply_markup:{ force_reply:true } });
      }catch(e){
        console.error("[photo]", e);
        await sendMessage(chatId,"No pude obtener la imagen, Mar.");
      }
      return ok();
    }

    // Respuestas (nombre / precio)
    const sess = sessions.get(chatId);
    if (sess) {
      // Nombre
      if (sess.step === "NAME" && msg.text){
        sess.title = msg.text.trim().slice(0,80);
        sess.step  = "FABRIC";
        sessions.set(chatId, sess);
        await sendMessage(chatId, "🧵 Elegí la tela:", { reply_markup: fabricKeyboard(), parse_mode:"Markdown" });
        return ok();
      }
      // Precio
      if (sess.step === "PRICE" && msg.text){
        const price = parsePrice(msg.text);
        if (price == null){ await sendMessage(chatId,"Precio inválido. Escribí solo el número (ej: 25999)."); return ok(); }

        const title = sess.title || `Sofy ${sess.fabric} (${(sess.sizes||[]).join(",")})`;
        const description = `Tela: ${sess.fabric} · Talles: ${sess.sizes.join(", ")} · Precio: $${price} ARS`;
        const tags = [String(sess.fabric||"").toLowerCase(), ...(sess.sizes||[]).map(s=>s.toLowerCase())];

        try {
          const addRes = await fetch(ADD_URL, {
            method: "POST",
            headers: { "Content-Type":"application/json", "x-api-key": API_KEY },
            body: JSON.stringify({ title, description, image: sess.imageUrl, tags })
          }).then(r=>r.json()).catch(e=>({ ok:false, error:String(e) }));

          if (addRes?.ok) await sendMessage(chatId,"✅ Subido, Mar.");
          else {
            console.error("[addProduct]", addRes);
            await sendMessage(chatId,"❌ Hubo un error del servidor al subir, Mar.");
          }
        } catch (e) {
          console.error("[PRICE -> add]", e);
          await sendMessage(chatId,"❌ Error de red al subir.");
        }
        sessions.delete(chatId);
        return ok();
      }
    }

    // Fallback
    await sendMessage(chatId, "Mandame una foto para empezar, Mar. Para borrar, respondé a tu foto con /eliminar.");
    return ok();

  } catch (err) {
    console.error("[tgWebhook handler]", err);
    return ok({ note:"exception" });
  }
};