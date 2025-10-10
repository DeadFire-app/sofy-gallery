/**
 * tgWebhook: Bot de Telegram (Netlify Function, Node 18+)
 * Flujo:
 *   FOTO -> ASK_NAME (force_reply) -> FABRIC (botones) -> SIZES (multi) -> ASK_PRICE -> addProduct
 *   /eliminar (reply a tu propia foto) -> deleteProduct por URL
 *
 * ENVs requeridas en Netlify:
 *   BOT_TOKEN, API_KEY, ADD_URL, DELETE_URL
 */

const TG = (token) => ({
  api: `https://api.telegram.org/bot${token}`,
  file: `https://api.telegram.org/file/bot${token}`,
});
const H = { "Content-Type": "application/json" };
const J = (o) => JSON.stringify(o);
const ok = (o = { ok: true }) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: J(o),
});
const bad = (m) => ({
  statusCode: 400,
  headers: { "Content-Type": "application/json" },
  body: J({ ok: false, error: m }),
});

/* ------------------- Telas ------------------- */
const FABRICS = [
  "Algodón","Algodón peinado","Lino","Viscosa","Modal","Rayón","Acetato","Oxford","Poplina","Muselina","Voile","Fibrana","Rústico","Broderie",
  "Lycra","Spandex","Morley","Micromorley","Jersey","Elastano","Wafle",
  "Microfibra","Dry-fit","Técnica","Supplex","Acrílico",
  "Friza","Polar","Pañolén","Lana","Bremer",
  "Satinado","Crepé","Crep","Velvet (terciopelo)","Chiffón","Organza","Encaje","Tull","Hawaii",
  "Gabardina","Bengalina","Jean / Denim","Twill","Canvas","Ecocuero","Cuero ecológico","Engomado"
].map((label, i) => ({ code: `F${i.toString().padStart(2, "0")}`, label }));

/* ------------------- Talles ------------------- */
const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "Único"];

/* ------------------- Teclados ------------------- */
const fabricKeyboard = () => ({
  inline_keyboard: FABRICS.reduce((rows, f, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: f.label, callback_data: `FAB:${f.code}` });
    return rows;
  }, []),
});
const sizesKeyboard = (selected = []) => {
  const S = new Set(selected);
  const rows = [];
  for (let i = 0; i < SIZES.length; i += 4) {
    rows.push(
      SIZES.slice(i, i + 4).map((sz) => ({
        text: `${S.has(sz) ? "✅ " : ""}${sz}`,
        callback_data: `SIZE:${sz}`,
      }))
    );
  }
  rows.push([
    { text: "❌ Cancelar", callback_data: "CANCEL" },
    { text: "✅ Continuar", callback_data: "NEXT" },
  ]);
  return { inline_keyboard: rows };
};
const fabricLabel = (code) => FABRICS.find((f) => f.code === code)?.label || code;

/* ------------------- Meta embebida (sin DB) ------------------- */
const buildMeta = (obj) => {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(`${k}=${Array.isArray(v) ? v.join(",") : String(v ?? "")}`);
  }
  return `\n\n#META ${parts.join(";")}`;
};
const parseMeta = (text = "") => {
  const m = text.match(/#META\s+([^\n]+)/);
  if (!m) return {};
  const out = {};
  m[1].split(";").forEach((kv) => {
    const [k, v] = kv.split("=");
    if (!k) return;
    out[k] = k === "SIZES" ? (v ? v.split(",").filter(Boolean) : []) : (v ?? "");
  });
  return out;
};

/* ------------------- Fetch con timeout ------------------- */
async function fetchTO(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally { clearTimeout(id); }
}

/* Telegram helpers */
const tgSend     = (tg, p) => fetchTO(`${tg.api}/sendMessage`, { method:"POST", headers:H, body:J(p) }, 5000);
const tgEditText = (tg, p) => fetchTO(`${tg.api}/editMessageText`, { method:"POST", headers:H, body:J(p) }, 5000);
const tgEditMK   = (tg, p) => fetchTO(`${tg.api}/editMessageReplyMarkup`, { method:"POST", headers:H, body:J(p) }, 5000);
const tgAnswerCb = (tg, p) => fetchTO(`${tg.api}/answerCallbackQuery`, { method:"POST", headers:H, body:J(p) }, 4000);

/* Precio parsing (ARS) */
const parsePrice = (t = "") => {
  const s = String(t).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
};

/* ------------------- Handler ------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204 };
  if (event.httpMethod !== "POST") return bad("POST only");

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const API_KEY   = process.env.API_KEY   || "";
  const ADD_URL   = process.env.ADD_URL;
  const DELETE_URL= process.env.DELETE_URL;

  if (!BOT_TOKEN || !ADD_URL || !DELETE_URL) return bad("Missing envs");
  const tg = TG(BOT_TOKEN);

  let upd;
  try { upd = JSON.parse(event.body || "{}"); }
  catch { return bad("Invalid JSON"); }

  /* --------- CALLBACKS (botones) --------- */
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const data = cq.data || "";
    const chatId = cq.message?.chat?.id;
    const msgId  = cq.message?.message_id;
    const text   = cq.message?.text || "";
    const meta   = parseMeta(text);

    try { await tgAnswerCb(tg, { callback_query_id: cq.id }); } catch (e) { console.error("[answerCb]", e); }
    if (!chatId || !msgId) return ok();

    // Elegir tela
    if (data.startsWith("FAB:")) {
      const code = data.slice(4);
      const newText =
        `Perfecto, Mar. 🧵 Tela seleccionada: ${fabricLabel(code)}.\n` +
        `Ahora elegí los talles (podés marcar varias opciones).` +
        buildMeta({ STEP:"SIZES", IMG: meta.IMG || "", NAME: meta.NAME || "", FAB: code, SIZES: meta.SIZES || [] });

      try { await tgEditText(tg, { chat_id: chatId, message_id: msgId, text: newText }); } catch (e) { console.error("[edit FAB]", e); }
      try { await tgEditMK(tg, { chat_id: chatId, message_id: msgId, reply_markup: sizesKeyboard(meta.SIZES || []) }); } catch (e) { console.error("[mk FAB]", e); }
      return ok();
    }

    // Toggle talles
    if (data.startsWith("SIZE:")) {
      const sz = data.slice(5);
      const set = new Set(meta.SIZES || []);
      set.has(sz) ? set.delete(sz) : set.add(sz);
      const arr = Array.from(set);
      const newText =
        text.replace(/#META[^\n]+/, "").trimEnd() +
        buildMeta({ STEP:"SIZES", IMG: meta.IMG || "", NAME: meta.NAME || "", FAB: meta.FAB || "", SIZES: arr });

      try { await tgEditText(tg, { chat_id: chatId, message_id: msgId, text: newText }); } catch (e) { console.error("[edit SIZE]", e); }
      try { await tgEditMK(tg, { chat_id: chatId, message_id: msgId, reply_markup: sizesKeyboard(arr) }); } catch (e) { console.error("[mk SIZE]", e); }
      return ok();
    }

    // Continuar -> pedir precio
    if (data === "NEXT") {
      const sizes = meta.SIZES || [];
      if (!meta.FAB)   { try { await tgAnswerCb(tg, { callback_query_id: cq.id, text: "Elegí una tela primero" }); } catch {} ; return ok(); }
      if (sizes.length === 0) { try { await tgAnswerCb(tg, { callback_query_id: cq.id, text: "Seleccioná al menos un talle" }); } catch {} ; return ok(); }

      const confirmText =
        `Genial, Mar.\n` +
        `✅ Nombre: ${meta.NAME || '-'}\n` +
        `✅ Tela: ${fabricLabel(meta.FAB)}\n` +
        `✅ Talles: ${sizes.join(", ")}\n` +
        `Ahora decime el precio en ARS (solo número, ej: 25999).` +
        buildMeta({ ASK_PRICE:"1", IMG: meta.IMG || "", NAME: meta.NAME || "", FAB: meta.FAB, SIZES: sizes });

      try { await tgEditText(tg, { chat_id: chatId, message_id: msgId, text: confirmText }); } catch (e) { console.error("[NEXT edit]", e); }
      try { await tgEditMK(tg, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }); } catch {}

      const ask =
        `💵 Precio ARS?\n(Escribí solo el número, ej: 25999)` +
        buildMeta({ ASK_PRICE:"1", IMG: meta.IMG || "", NAME: meta.NAME || "", FAB: meta.FAB, SIZES: sizes });
      try { await tgSend(tg, { chat_id: chatId, text: ask, reply_markup: { force_reply: true } }); } catch (e) { console.error("[NEXT ask price]", e); }
      return ok();
    }

    // Cancelar
    if (data === "CANCEL") {
      try { await tgEditText(tg, { chat_id: chatId, message_id: msgId, text: "Operación cancelada, Mar. 💫" }); } catch (e) { console.error("[cancel edit]", e); }
      try { await tgEditMK(tg, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }); } catch {}
      return ok();
    }

    return ok();
  }

  /* --------- MENSAJES --------- */
  const msg    = upd.message || upd.edited_message;
  if (!msg) return ok();
  const chatId = msg.chat?.id;

  // /start
  if (msg.text && msg.text.trim().startsWith("/start")) {
    try {
      await tgSend(tg, {
        chat_id: chatId,
        text:
          "Hola Mar 👋\n" +
          "Mandame una FOTO para cargar un producto.\n" +
          "Flujo: Nombre → Tela (botones) → Talles (multi) → Precio (ARS).\n" +
          "Para borrar, respondé a tu propia foto con /eliminar."
      });
    } catch (e) { console.error("[/start sendMessage]", e); }
    return ok();
  }

  // /eliminar (reply a TU foto)
  if (msg.text && msg.text.trim().split(/\s+/)[0].toLowerCase() === "/eliminar") {
    const replied = msg.reply_to_message;
    if (!replied) { try { await tgSend(tg, { chat_id: chatId, text: "Usá /eliminar como respuesta a tu *propia* foto, Mar.", parse_mode:"Markdown" }); } catch {} ; return ok(); }
    if (!replied.photo) { try { await tgSend(tg, { chat_id: chatId, text: "Ese mensaje no tiene foto, Mar." }); } catch {} ; return ok(); }
    if ((replied.from?.id) !== msg.from?.id) { try { await tgSend(tg, { chat_id: chatId, text: "Tiene que ser tu *propio* mensaje con la foto, Mar.", parse_mode:"Markdown" }); } catch {} ; return ok(); }

    let gf = null;
    try {
      const largest = replied.photo.reduce((a,b)=> (a.file_size||0)>(b.file_size||0)?a:b);
      gf = await fetchTO(`${tg.api}/getFile?file_id=${largest.file_id}`, {}, 5000).then(r=>r.json());
    } catch (e) { console.error("[getFile for delete]", e); }
    if (!gf || !gf.ok) { try { await tgSend(tg, { chat_id: chatId, text: "No pude obtener la imagen, Mar." }); } catch {} ; return ok(); }
    const imageUrl = `${tg.file}/${gf.result.file_path}`;

    let del = null;
    try {
      del = await fetchTO(DELETE_URL, {
        method: "POST",
        headers: { ...H, "x-api-key": API_KEY },
        body: J({ image: imageUrl })
      }, 5000).then(r=>r.json());
    } catch (e) { console.error("[delete fetch]", e); }

    if (del?.ok && del.removedCount > 0) { try { await tgSend(tg, { chat_id: chatId, text: `🗑️ Listo, Mar. Eliminé ${del.removedCount} elemento(s).` }); } catch {} }
    else { try { await tgSend(tg, { chat_id: chatId, text: "No encontré esa imagen en el catálogo, Mar." }); } catch {} }
    return ok();
  }

  // Respuestas con force_reply (ASK_NAME o ASK_PRICE)
  if (msg.text && msg.reply_to_message && /#META\s+/.test(msg.reply_to_message.text || "")) {
    const meta = parseMeta(msg.reply_to_message.text);

    // Nombre de prenda
    if (meta.ASK_NAME) {
      const name = (msg.text || "").trim().slice(0, 80);
      if (!name) { try { await tgSend(tg, { chat_id: chatId, text: "Nombre inválido, probá de nuevo." }); } catch {} ; return ok(); }
      const intro =
        `Nombre: ${name}\nElegí la tela:` +
        buildMeta({ STEP:"FABRIC", IMG: meta.IMG || "", NAME: name, FAB: "", SIZES: [] });
      try { await tgSend(tg, { chat_id: chatId, text: intro, reply_markup: fabricKeyboard() }); } catch (e) { console.error("[after name → fabric]", e); }
      return ok();
    }

    // Precio
    if (meta.ASK_PRICE) {
      const price = parsePrice(msg.text);
      if (price == null) { try { await tgSend(tg, { chat_id: chatId, text: "Precio inválido. Ej: 25999" }); } catch {} ; return ok(); }

      const fab   = fabricLabel(meta.FAB);
      const sizes = meta.SIZES || [];
      const title = meta.NAME ? meta.NAME : `Sofy ${fab} (${sizes.join(",")})`;
      const description = `Tela: ${fab} · Talles: ${sizes.join(", ")} · Precio: $${price} ARS`;
      const tags = [fab.toLowerCase(), ...sizes.map((s)=>s.toLowerCase()), "auto"];

      let add = null;
      try {
        add = await fetchTO(ADD_URL, {
          method: "POST",
          headers: { ...H, "x-api-key": API_KEY },
          body: J({ title, description, image: meta.IMG, tags })
        }, 5000).then(r=>r.json());
      } catch (e) { console.error("[add fetch]", e); }

      if (add?.ok) { try { await tgSend(tg, { chat_id: chatId, text: "✅ Subido, Mar." }); } catch {} }
      else { try { await tgSend(tg, { chat_id: chatId, text: "❌ Hubo un error del servidor al subir, Mar." }); } catch {} }
      return ok();
    }
  }

  // FOTO -> pedir NOMBRE
  if (msg.photo) {
    let gf = null;
    try {
      const largest = msg.photo.reduce((a,b)=> (a.file_size||0)>(b.file_size||0)?a:b);
      gf = await fetchTO(`${tg.api}/getFile?file_id=${largest.file_id}`, {}, 5000).then(r=>r.json());
    } catch (e) { console.error("[getFile]", e); }
    if (!gf || !gf.ok) { try { await tgSend(tg, { chat_id: chatId, text: "No pude obtener la imagen, Mar." }); } catch {} ; return ok(); }
    const imageUrl = `${tg.file}/${gf.result.file_path}`;

    const ask =
      `📝 ¿Nombre de la prenda?\n(Ej: Remera Oversize)` +
      buildMeta({ ASK_NAME:"1", IMG:imageUrl, NAME:"", FAB:"", SIZES:[] });
    try { await tgSend(tg, { chat_id: chatId, text: ask, reply_markup: { force_reply: true } }); } catch (e) { console.error("[ASK_NAME send]", e); }
    return ok();
  }

  // Fallback
  try { await tgSend(tg, { chat_id: chatId, text: "Mandame una foto para empezar, Mar. Para borrar, respondé a tu foto con /eliminar." }); } catch {}
  return ok();
};