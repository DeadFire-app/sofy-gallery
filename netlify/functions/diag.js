// Diagnóstico: verifica ENVs y envía un mensaje directo al chat_id dado.
// Uso:
//   https://<tu-sitio>.netlify.app/.netlify/functions/diag?chat_id=123456&text=Hola
// Nota: CONSEGUI TU chat_id con @userinfobot en Telegram.

export async function handler(event) {
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  const ADD_URL   = process.env.ADD_URL   || "";
  const DEL_URL   = process.env.DELETE_URL|| "";
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!ADD_URL)   missing.push("ADD_URL");
  if (!DEL_URL)   missing.push("DELETE_URL");

  const params = new URLSearchParams(event.queryStringParameters || {});
  const chat_id = params.get("chat_id");
  const text    = params.get("text") || "Ping de diagnóstico: Sofy OK";

  let sendResult = null, sendError = null;
  if (chat_id && BOT_TOKEN) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ chat_id, text })
      });
      const json = await res.json();
      sendResult = { status: res.status, json };
    } catch (e) {
      sendError = String(e);
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      ok: true,
      envs: {
        BOT_TOKEN: !!BOT_TOKEN,
        ADD_URL: !!ADD_URL,
        DELETE_URL: !!DEL_URL
      },
      missing,
      test_send: chat_id ? (sendResult || { error: sendError }) : "provide ?chat_id=XXXX"
    })
  };
}