/**
 * addProduct: agrega un item al inicio de data.json en GitHub
 * POST JSON: { title, description, image, tags? }
 * Requiere header x-api-key si API_KEY está seteada.
 */
const GH_API = "https://api.github.com";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
};

const ok  = (obj) => ({ statusCode: 200, headers: { ...jsonHeaders, ...corsHeaders }, body: JSON.stringify(obj) });
const bad = (msg) => ({ statusCode: 400, headers: { ...jsonHeaders, ...corsHeaders }, body: JSON.stringify({ ok:false, error: msg }) });
const err = (msg, status=500) => ({ statusCode: status, headers: { ...jsonHeaders, ...corsHeaders }, body: JSON.stringify({ ok:false, error: msg }) });

const cleanStr = (s, max=200) => String(s || "").trim().slice(0, max);
const normalizeTags = (tags) => (Array.isArray(tags) ? tags : [])
  .map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 10);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode:204, headers:corsHeaders };
  if (event.httpMethod !== "POST")    return err("Only POST allowed", 405);

  const requiredKey = process.env.API_KEY;
  if (requiredKey) {
    const key = event.headers["x-api-key"] || event.headers["X-API-KEY"];
    if (key !== requiredKey) return err("Unauthorized", 401);
  }

  try {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    const path  = process.env.DATA_PATH || "data.json";
    const branch= process.env.BRANCH || "main";
    if (!token || !owner || !repo) return err("Missing owner/repo/token", 500);

    const body = JSON.parse(event.body || "{}");
    const title = cleanStr(body.title);
    const description = cleanStr(body.description, 1000);
    const image = cleanStr(body.image, 1000);
    let tags = normalizeTags(body.tags ?? []);
    if (!title || !description || !image) return bad("Missing fields: title, description, image.");
    if (tags.length === 0) tags = ["general"];

    const newItem = { id: Date.now(), title, description, image, tags, createdAt: new Date().toISOString() };

    const headers = { Authorization: `Bearer ${token}`, "User-Agent": "netlify-fn" };
    const getUrl = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
    const getRes = await fetch(getUrl, { headers });

    if (getRes.status === 404) {
      const contentB64 = Buffer.from(JSON.stringify([newItem], null, 2) + "\n").toString("base64");
      const putRes = await fetch(getUrl.replace(/\?ref=.*/, ""), {
        method: "PUT", headers: { ...headers, "Content-Type":"application/json" },
        body: JSON.stringify({ message: `chore: create ${path} and add "${title}"`, content: contentB64, branch }),
      });
      if (!putRes.ok) return err(`GitHub create error: ${putRes.status} ${await putRes.text()}`);
      return ok({ ok:true, created:true, id:newItem.id });
    }

    if (!getRes.ok) return err(`GitHub read error: ${getRes.status} ${await getRes.text()}`);
    const ghFile = await getRes.json();
    const sha = ghFile.sha;
    const current = JSON.parse(Buffer.from(ghFile.content, "base64").toString("utf8"));
    if (!Array.isArray(current)) return err("data.json must be an array", 500);

    const updated = [newItem, ...current];
    const contentB64 = Buffer.from(JSON.stringify(updated, null, 2) + "\n").toString("base64");
    const putUrl = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const putRes = await fetch(putUrl, {
      method:"PUT", headers:{ ...headers, "Content-Type":"application/json" },
      body: JSON.stringify({ message:`chore: add "${title}" to ${path}`, content: contentB64, sha, branch }),
    });
    if (!putRes.ok) return err(`GitHub write error: ${putRes.status} ${await putRes.text()}`);

    return ok({ ok:true, id:newItem.id });
  } catch (e) {
    console.error("[addProduct] fatal:", e);
    return err("Internal error", 500);
  }
};