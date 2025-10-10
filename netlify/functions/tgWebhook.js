/**
 * tgWebhook: Bot de Telegram (Node) con flujo guiado:
 * - FOTO (sin caption):
 *    1) Tela (inline buttons)
 *    2) Talles (multi-selección con inline buttons)
 *    3) Precio (force reply; usuario escribe solo el precio)
 *    => addProduct (title/desc/tags generados)
 * - /eliminar como reply a TU foto: deleteProduct por image URL
 *
 * ENVs: BOT_TOKEN, API_KEY, ADD_URL, DELETE_URL
 */

const TG = (token) => ({
  api: `https://api.telegram.org/bot${token}`,
  file: `https://api.telegram.org/file/bot${token}`,
});

const ok   = (x={ok:true}) => ({ statusCode:200, body: JSON.stringify(x) });
const bad  = (m) => ({ statusCode:400, body: JSON.stringify({ok:false,error:m}) });
const j    = (o) => JSON.stringify(o);
const H    = { "Content-Type":"application/json" };

// Opciones (podés editar etiquetas sin tocar los códigos)
const FABRICS = [
  { code:"ALG", label:"Algodón" },
  { code:"POL", label:"Poliéster" },
  { code:"LYC", label:"Lycra" },
  { code:"SAT", label:"Satinado" },
  { code:"JEA", label:"Jean" },
  { code:"LIN", label:"Lino" },
  { code:"FRI", label:"Friza" },
  { code:"GAB", label:"Gabardina" },
  { code:"ACE", label:"Acetato" },
];

const SIZES = ["XS","S","M","L","XL","XXL","XXXL","Único"];

// Helpers Telegram
const tgSend = (tg, payload) => fetch(`${tg.api}/sendMessage`, { method:"POST", headers:H, body:j(payload) });
const tgEditText = (tg, payload) => fetch(`${tg.api}/editMessageText`, { method:"POST", headers:H, body:j(payload) });
const tgEditMarkup = (tg, payload) => fetch(`${tg.api}/editMessageReplyMarkup`, { method:"POST", headers:H, body:j(payload) });
const tgAnswerCb = (tg, payload) => fetch(`${tg.api}/answerCallbackQuery`, { method:"POST", headers:H, body:j(payload) });

// Meta-state embebido en el texto del mensaje (evita DB)
const buildMeta = (obj) => {
  const parts = [];
  for (const [k,v] of Object.entries(obj)) {
    if (Array.isArray(v)) parts.push(`${k}=${v.join(",")}`);
    else parts.push(`${k}=${String(v ?? "")}`);
  }
  return `\n\n#META ${parts.join(";")}`;
};
const parseMeta = (text="") => {
  const m = text.match(/#META\s+([^\n]+)/);
  if (!m) return {};
  const kvs = m[1].split(";").map(s=>s.trim()).filter(Boolean);
  const out = {};
  kvs.forEach(pair => {
    const [k, v] = pair.split("=");
    if (!k) return;
    if (k === "SIZES") out[k] = v ? v.split(",").filter(Boolean) : [];
    else out[k] = v ?? "";
  });
  return out;
};

// Keyboards
const fabricKeyboard = () => ({
  inline_keyboard: FABRICS.reduce((rows, f, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length-1].push({ text: f.label, callback_data: `FAB:${f.code}` });
    return rows;
  }, [])
});

const sizesKeyboard = (selected=[]) => {
  const sel = new Set(selected);
  const rows = [];
  for (let i=0;i<SIZES.length;i+=4){
    const row = SIZES.slice(i,i+4).map(sz => ({
      text: `${sel.has(sz) ? "✅ " : ""}${sz}`, callback_data: `SIZE:${sz}`
    }));
    rows.push(row);
  }
  rows.push([
    { text:"❌ Cancelar", callback_data:"CANCEL" },
    { text:"✅ Continuar", callback_data:"NEXT" }
  ]);
  return { inline_keyboard: rows };
};

const findFabricLabel = (code) => FABRICS.find(f=>f.code===code)?.label || code;

// Price parsing
const parsePrice = (t="") => {
  const s = String(t).replace(/[^\d.,]/g,"").replace(/\./g,"").replace(",","."); // "1.234,56" -> "1234.56"
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n*100)/100;
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode:204 };
  if (event.httpMethod !== "POST") return bad("POST only");

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const API_KEY   = process.env.API_KEY || "";
  const ADD_URL   = process.env.ADD_URL;
  const DELETE_URL= process.env.DELETE_URL;
  if (!BOT_TOKEN || !ADD_URL || !DELETE_URL) return bad("Missing envs");
  const tg = TG(BOT_TOKEN);

  const upd = JSON.parse(event.body || "{}");

  // --- CALLBACK QUERIES (botones) ---
  if (upd.callback_query){
    const cq = upd.callback_query;
    const data = cq.data || "";
    const chatId = cq.message?.chat?.id;
    const msgId  = cq.message?.message_id;
    const text   = cq.message?.text || "";
    const meta   = parseMeta(text); // { STEP, IMG, FAB, SIZES[] }

    await tgAnswerCb(tg, { callback_query_id: cq.id }); // quitar "Loading…"

    if (!chatId || !msgId) return ok();

    // Elegir tela
    if (data.startsWith("FAB:")){
      const code = data.slice(4);
      const newText = `🧵 Tela seleccionada: *${findFabricLabel(code)}*.\nAhora elegí los *talles* (podés marcar varias opciones).` + buildMeta({
        STEP:"SIZES", IMG: meta.IMG || "", FAB: code, SIZES: meta.SIZES || []
      });
      await tgEditText(tg, {
        chat_id: chatId, message_id: msgId,
        text: newText, parse_mode: "Markdown"
      });
      await tgEditMarkup(tg, {
        chat_id: chatId, message_id: msgId,
        reply_markup: sizesKeyboard(meta.SIZES || [])
      });
      return ok();
    }

    // Toggle talles
    if (data.startsWith("SIZE:")){
      const sz = data.slice(5);
      const selected = new Set(meta.SIZES || []);
      if (selected.has(sz)) selected.delete(sz); else selected.add(sz);
      const arr = Array.from(selected);
      const newText = text.replace(/#META[^\n]+/, "") // limpia meta previa
        .replace(/\s+$/,"") +
        buildMeta({ STEP:"SIZES", IMG: meta.IMG || "", FAB: meta.FAB || "", SIZES: arr });
      await tgEditText(tg, { chat_id: chatId, message_id: msgId, text: newText, parse_mode:"Markdown" });
      await tgEditMarkup(tg, { chat_id: chatId, message_id: msgId, reply_markup: sizesKeyboard(arr) });
      return ok();
    }

    // Continuar a precio
    if (data === "NEXT"){
      const sizes = meta.SIZES || [];
      if (!meta.FAB) {
        await tgAnswerCb(tg, { callback_query_id: cq.id, text:"Elegí una tela primero" });
        return ok();
      }
      if (sizes.length === 0){
        await tgAnswerCb(tg, { callback_query_id: cq.id, text:"Seleccioná al menos un talle" });
        return ok();
      }
      const fabLabel = findFabricLabel(meta.FAB);
      const priceAsk = `💵 Precio en ARS?\nProducto: *${fabLabel}*\nTalles: *${sizes.join(", ")}*\n(Escribí solo el número, ej: 25999)\n` +
        buildMeta({ ASK_PRICE:"1", IMG:meta.IMG||"", FAB:meta.FAB, SIZES:sizes });
      await tgSend(tg, {
        chat_id: chatId,
        text: priceAsk,
        parse_mode:"Markdown",
        reply_markup: { force_reply: true }
      });
      return ok();
    }

    // Cancelar
    if (data === "CANCEL"){
      await tgEditText(tg, { chat_id: chatId, message_id: msgId, text: "❌ Operación cancelada." });
      await tgEditMarkup(tg, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      return ok();
    }

    return ok();
  }

  // --- MENSAJES ---
  const msg = upd.message || upd.edited_message;
  if (!msg) return ok();
  const chatId = msg.chat?.id;

  // /start
  if (msg.text && msg.text.trim().startsWith("/start")){
    await tgSend(tg, { chat_id: chatId, text:
      "Hola! Mandame una *FOTO*.\nTe voy a pedir:\n1) Tela (botones)\n2) Talles (podés elegir varias)\n3) Precio (ARS)\n\nPara eliminar, respondé a tu *propia foto* con /eliminar.",
      parse_mode:"Markdown"
    });
    return ok();
  }

  // /eliminar como reply a TU foto
  if (msg.text && msg.text.trim().split(/\s+/)[0].toLowerCase() === "/eliminar"){
    const replied = msg.reply_to_message;
    if (!replied){ await tgSend(tg,{chat_id:chatId, text:"❌ Usá /eliminar como *respuesta* a tu propia foto."}); return ok(); }
    if (!replied.photo){ await tgSend(tg,{chat_id:chatId, text:"❌ Ese mensaje no tiene foto."}); return ok(); }
    if ((replied.from?.id) !== msg.from?.id){ await tgSend(tg,{chat_id:chatId, text:"❌ Debe ser tu *propio* mensaje con la foto."}); return ok(); }

    // Obtener URL pública de la foto
    const largest = replied.photo.reduce((a,b)=> (a.file_size||0)>(b.file_size||0)?a:b);
    const gf = await fetch(`${tg.api}/getFile?file_id=${largest.file_id}`).then(r=>r.json()).catch(()=>null);
    if (!gf?.ok){ await tgSend(tg,{chat_id:chatId, text:"❌ No pude obtener la imagen."}); return ok(); }
    const imageUrl = `${tg.file}/${gf.result.file_path}`;

    const delRes = await fetch(DELETE_URL, {
      method:"POST",
      headers:{ ...H, "x-api-key": API_KEY },
      body:j({ image: imageUrl })
    }).then(r=>r.json()).catch(()=>null);

    if (delRes?.ok && delRes.removedCount>0) await tgSend(tg,{chat_id:chatId, text:`🗑️ Eliminado: ${delRes.removedCount} elemento(s).`});
    else await tgSend(tg,{chat_id:chatId, text:"⚠️ No encontré esa imagen en la galería."});
    return ok();
  }

  // RESPUESTA de precio (force_reply) → reply_to_message con #META ASK_PRICE
  if (msg.text && msg.reply_to_message && /#META\s+/.test(msg.reply_to_message.text || "")){
    const meta = parseMeta(msg.reply_to_message.text);
    if (meta.ASK_PRICE){
      const price = parsePrice(msg.text);
      if (price == null){ await tgSend(tg,{chat_id:chatId, text:"❌ Precio inválido. Ejemplo: 25999"}); return ok(); }

      // Componer payload de alta
      const fabLabel = findFabricLabel(meta.FAB);
      const sizes = meta.SIZES || [];
      const title = `Sofy ${fabLabel} (${sizes.join(",")})`;
      const description = `Tela: ${fabLabel} · Talles: ${sizes.join(", ")} · Precio: $${price} ARS`;
      const tags = [fabLabel.toLowerCase(), ...sizes.map(s=>s.toLowerCase()), "auto"];

      const addRes = await fetch(ADD_URL, {
        method:"POST",
        headers:{ ...H, "x-api-key": API_KEY },
        body:j({ title, description, image: meta.IMG, tags })
      }).then(r=>r.json()).catch(()=>null);

      if (addRes?.ok) await tgSend(tg,{chat_id:chatId, text:"✅ Subido"});
      else await tgSend(tg,{chat_id:chatId, text:"❌ Error del servidor al subir."});
      return ok();
    }
  }

  // FOTO sin caption → iniciar flujo (Tela)
  if (msg.photo){
    // Get URL pública
    const largest = msg.photo.reduce((a,b)=> (a.file_size||0)>(b.file_size||0)?a:b);
    const gf = await fetch(`${tg.api}/getFile?file_id=${largest.file_id}`).then(r=>r.json()).catch(()=>null);
    if (!gf?.ok){ await tgSend(tg,{chat_id:chatId, text:"❌ No pude obtener la imagen."}); return ok(); }
    const imageUrl = `${tg.file}/${gf.result.file_path}`;

    const text = `🖼️ Foto recibida.\nElegí la *tela*:` + buildMeta({ STEP:"FABRIC", IMG:imageUrl, FAB:"", SIZES:[] });
    await tgSend(tg, {
      chat_id: chatId,
      text, parse_mode:"Markdown",
      reply_markup: fabricKeyboard()
    });
    return ok();
  }

  // fallback
  await tgSend(tg,{chat_id:chatId, text:"📸 Mandá una foto para empezar. Para eliminar, respondé con /eliminar a tu foto."});
  return ok();
};