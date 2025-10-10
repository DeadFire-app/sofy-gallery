/**
 * tgWebhook: Bot de Telegram (Node) con flujo guiado:
 * - FOTO sin caption:
 *    1) Tela (inline buttons)
 *    2) Talles (multi-selección)
 *    3) Precio (force reply)
 *    => addProduct
 * - /eliminar como reply a TU foto: deleteProduct por image URL
 *
 * ENVs: BOT_TOKEN, API_KEY, ADD_URL, DELETE_URL
 */
const TG = (t)=>({ api:`https://api.telegram.org/bot${t}`, file:`https://api.telegram.org/file/bot${t}` });
const H = { "Content-Type":"application/json" };
const j = (o)=>JSON.stringify(o);
const ok = (o={ok:true})=>({ statusCode:200, body:j(o) });
const bad= (m)=>({ statusCode:400, body:j({ok:false,error:m}) });

const FABRICS = [
  { code:"ALG", label:"Algodón" }, { code:"LIN", label:"Lino" }, { code:"POL", label:"Poliéster" },
  { code:"LYC", label:"Lycra" },   { code:"SAT", label:"Satinado" }, { code:"JEA", label:"Jean" },
  { code:"FRI", label:"Friza" },   { code:"GAB", label:"Gabardina" }, { code:"ACE", label:"Acetato" }
];
const SIZES = ["XS","S","M","L","XL","XXL","XXXL","Único"];

const fabricKb = ()=>({
  inline_keyboard: FABRICS.reduce((rows,f,i)=>{ if(i%3===0) rows.push([]); rows[rows.length-1].push({text:f.label,callback_data:`FAB:${f.code}`}); return rows; },[])
});
const sizesKb = (sel=[])=>{
  const S = new Set(sel);
  const rows=[];
  for(let i=0;i<SIZES.length;i+=4){
    rows.push(SIZES.slice(i,i+4).map(sz=>({ text:`${S.has(sz)?"✅ ":""}${sz}`, callback_data:`SIZE:${sz}` })));
  }
  rows.push([{text:"❌ Cancelar",callback_data:"CANCEL"},{text:"✅ Continuar",callback_data:"NEXT"}]);
  return { inline_keyboard: rows };
};
const findFabric = (code)=> FABRICS.find(f=>f.code===code)?.label || code;

const buildMeta = (obj)=>{
  const parts=[]; for(const [k,v] of Object.entries(obj)){ parts.push(`${k}=${Array.isArray(v)?v.join(","):String(v??"")}`); }
  return `\n\n#META ${parts.join(";")}`;
};
const parseMeta = (text="")=>{
  const m = text.match(/#META\s+([^\n]+)/); if(!m) return {};
  const out={}; m[1].split(";").forEach(kv=>{
    const [k,v] = kv.split("="); if(!k) return;
    out[k] = k==="SIZES" ? (v?v.split(",").filter(Boolean):[]) : (v??"");
  }); return out;
};
const tgSend=(tg,p)=>fetch(`${tg.api}/sendMessage`,{method:"POST",headers:H,body:j(p)});
const tgEdit=(tg,p)=>fetch(`${tg.api}/editMessageText`,{method:"POST",headers:H,body:j(p)});
const tgEditMk=(tg,p)=>fetch(`${tg.api}/editMessageReplyMarkup`,{method:"POST",headers:H,body:j(p)});
const tgAns=(tg,p)=>fetch(`${tg.api}/answerCallbackQuery`,{method:"POST",headers:H,body:j(p)});

const priceParse=(t="")=>{
  const s = String(t).replace(/[^\d.,]/g,"").replace(/\./g,"").replace(",",".");
  const n = parseFloat(s); return isNaN(n)?null:Math.round(n*100)/100;
};

exports.handler = async (event)=>{
  if (event.httpMethod==="OPTIONS") return { statusCode:204 };
  if (event.httpMethod!=="POST")    return bad("POST only");

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const API_KEY   = process.env.API_KEY || "";
  const ADD_URL   = process.env.ADD_URL;
  const DELETE_URL= process.env.DELETE_URL;
  if (!BOT_TOKEN || !ADD_URL || !DELETE_URL) return bad("Missing envs");
  const tg = TG(BOT_TOKEN);

  const upd = JSON.parse(event.body||"{}");

  // --- CALLBACKS ---
  if (upd.callback_query){
    const cq = upd.callback_query;
    const data = cq.data||"";
    const chatId = cq.message?.chat?.id;
    const msgId  = cq.message?.message_id;
    const text   = cq.message?.text || "";
    const meta   = parseMeta(text);
    await tgAns(tg,{callback_query_id:cq.id});

    if (!chatId||!msgId) return ok();

    if (data.startsWith("FAB:")){
      const code=data.slice(4);
      const newText = `🧵 Tela: *${findFabric(code)}*.\nElegí *talles* (podés marcar varias).` + buildMeta({ STEP:"SIZES", IMG:meta.IMG||"", FAB:code, SIZES:meta.SIZES||[] });
      await tgEdit(tg,{ chat_id:chatId, message_id:msgId, text:newText, parse_mode:"Markdown" });
      await tgEditMk(tg,{ chat_id:chatId, message_id:msgId, reply_markup: sizesKb(meta.SIZES||[]) });
      return ok();
    }
    if (data.startsWith("SIZE:")){
      const sz = data.slice(5);
      const set = new Set(meta.SIZES||[]);
      set.has(sz) ? set.delete(sz) : set.add(sz);
      const arr = Array.from(set);
      const newText = text.replace(/#META[^\n]+/,"").trimEnd() + buildMeta({ STEP:"SIZES", IMG:meta.IMG||"", FAB:meta.FAB||"", SIZES:arr });
      await tgEdit(tg,{ chat_id:chatId, message_id:msgId, text:newText, parse_mode:"Markdown" });
      await tgEditMk(tg,{ chat_id:chatId, message_id:msgId, reply_markup: sizesKb(arr) });
      return ok();
    }
    if (data==="NEXT"){
      const sizes = meta.SIZES||[];
      if (!meta.FAB) { await tgAns(tg,{callback_query_id:cq.id,text:"Elegí una tela"}); return ok(); }
      if (sizes.length===0){ await tgAns(tg,{callback_query_id:cq.id,text:"Seleccioná al menos un talle"}); return ok(); }
      const ask = `💵 Precio ARS?\nTela: *${findFabric(meta.FAB)}*\nTalles: *${sizes.join(", ")}*\n(Escribí solo el número, ej: 25999)` + buildMeta({ ASK_PRICE:"1", IMG:meta.IMG||"", FAB:meta.FAB, SIZES:sizes });
      await tgSend(tg,{ chat_id:chatId, text:ask, parse_mode:"Markdown", reply_markup:{ force_reply:true } });
      return ok();
    }
    if (data==="CANCEL"){
      await tgEdit(tg,{ chat_id:chatId, message_id:msgId, text:"❌ Operación cancelada." });
      await tgEditMk(tg,{ chat_id:chatId, message_id:msgId, reply_markup:{ inline_keyboard:[] } });
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
    await tgSend(tg,{ chat_id:chatId, text:"Mandame una *FOTO*. Te pido tela → talles → precio y lo publico. Para borrar, respondé a tu *propia* foto con /eliminar.", parse_mode:"Markdown" });
    return ok();
  }

  // /eliminar (reply a tu foto)
  if (msg.text && msg.text.trim().split(/\s+/)[0].toLowerCase()==="/eliminar"){
    const replied = msg.reply_to_message;
    if (!replied){ await tgSend(tg,{chat_id:chatId,text:"❌ Usá /eliminar como respuesta a tu propia foto."}); return ok(); }
    if (!replied.photo){ await tgSend(tg,{chat_id:chatId,text:"❌ Ese mensaje no tiene foto."}); return ok(); }
    if ((replied.from?.id)!==(msg.from?.id)){ await tgSend(tg,{chat_id:chatId,text:"❌ Debe ser tu *propio* mensaje."}); return ok(); }

    const largest = replied.photo.reduce((a,b)=>(a.file_size||0)>(b.file_size||0)?a:b);
    const gf = await fetch(`${tg.api}/getFile?file_id=${largest.file_id}`).then(r=>r.json()).catch(()=>null);
    if (!gf?.ok){ await tgSend(tg,{chat_id:chatId,text:"❌ No pude obtener la imagen."}); return ok(); }
    const imageUrl = `${tg.file}/${gf.result.file_path}`;

    const res = await fetch(process.env.DELETE_URL,{
      method:"POST", headers:{...H, "x-api-key":API_KEY}, body:j({ image:imageUrl })
    }).then(r=>r.json()).catch(()=>null);

    if (res?.ok && res.removedCount>0) await tgSend(tg,{chat_id:chatId,text:`🗑️ Eliminado: ${res.removedCount} elemento(s).`});
    else await tgSend(tg,{chat_id:chatId,text:"⚠️ No encontré esa imagen en el catálogo."});
    return ok();
  }

  // Respuesta de precio
  if (msg.text && msg.reply_to_message && /#META\s+/.test(msg.reply_to_message.text||"")){
    const meta = parseMeta(msg.reply_to_message.text);
    if (meta.ASK_PRICE){
      const price = priceParse(msg.text);
      if (price==null){ await tgSend(tg,{chat_id:chatId,text:"❌ Precio inválido. Ej: 25999"}); return ok(); }
      const fab = findFabric(meta.FAB);
      const sizes = meta.SIZES||[];
      const title = `Sofy ${fab} (${sizes.join(",")})`;
      const description = `Tela: ${fab} · Talles: ${sizes.join(", ")} · Precio: $${price} ARS`;
      const tags = [fab.toLowerCase(), ...sizes.map(s=>s.toLowerCase()), "auto"];

      const res = await fetch(process.env.ADD_URL,{
        method:"POST", headers:{...H,"x-api-key":API_KEY},
        body:j({ title, description, image: meta.IMG, tags })
      }).then(r=>r.json()).catch(()=>null);

      if (res?.ok) await tgSend(tg,{chat_id:chatId,text:"✅ Subido"});
      else await tgSend(tg,{chat_id:chatId,text:"❌ Error del servidor al subir."});
      return ok();
    }
  }

  // Foto sin caption → inicio del flujo
  if (msg.photo){
    const largest = msg.photo.reduce((a,b)=>(a.file_size||0)>(b.file_size||0)?a:b);
    const gf = await fetch(`${tg.api}/getFile?file_id=${largest.file_id}`).then(r=>r.json()).catch(()=>null);
    if (!gf?.ok){ await tgSend(tg,{chat_id:chatId,text:"❌ No pude obtener la imagen."}); return ok(); }
    const imageUrl = `${tg.file}/${gf.result.file_path}`;

    const text = `🖼️ Foto recibida. Elegí la *tela*:` + ``
      + `\n` + buildMeta({ STEP:"FABRIC", IMG:imageUrl, FAB:"", SIZES:[] });
    await tgSend(tg,{ chat_id:chatId, text, parse_mode:"Markdown", reply_markup: fabricKb() });
    return ok();
  }

  // fallback
  await tgSend(tg,{chat_id:chatId,text:"📸 Mandá una foto para comenzar. Para borrar, respondé a tu foto con /eliminar."});
  return ok();
};