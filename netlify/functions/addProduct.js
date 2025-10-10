/**
 * addProduct: agrega un item al inicio de data.json en GitHub
 * POST JSON: { title, description, image, tags? }
 * Seguridad: si existe process.env.API_KEY, exige header "x-api-key"
 */

const GH_API = "https://api.github.com";

const HJSON = { "Content-Type": "application/json; charset=utf-8" };
const HCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
};

const ok  = (o) => ({ statusCode: 200, headers: { ...HJSON, ...HCORS }, body: JSON.stringify(o) });
const bad = (m) => ({ statusCode: 400, headers: { ...HJSON, ...HCORS }, body: JSON.stringify({ ok:false, error:m }) });
const err = (m, s=500) => ({ statusCode: s, headers: { ...HJSON, ...HCORS }, body: JSON.stringify({ ok:false, error:m }) });

const clean = (s, max=200) => String(s ?? "").trim().slice(0, max);
const normTags = (tags) => (Array.isArray(tags) ? tags : [])
  .map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 15);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HCORS };
  if (event.httpMethod !== "POST")    return err("Only POST allowed", 405);

  // auth simple por API_KEY (opcional)
  try {
    const needKey = process.env.API_KEY;
    if (needKey) {
      const k = event.headers["x-api-key"] || event.headers["X-API-KEY"];
      if (k !== needKey) return err("Unauthorized", 401);
    }

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    const path  = process.env.DATA_PATH || "data.json";
    const branch= "main"; // No uses env BRANCH (reservada en Netlify)

    if (!token || !owner || !repo) return err("Missing owner/repo/token", 500);

    const body = JSON.parse(event.body || "{}");
    const title = clean(body.title, 160);
    const description = clean(body.description, 1200);
    const image = clean(body.image, 1200);
    let tags = normTags(body.tags || []);
    if (!title || !description || !image) return bad("Missing fields: title, description, image.");
    if (tags.length === 0) tags = ["general"];

    const item = {
      id: Date.now(),
      title, description, image, tags,
      createdAt: new Date().toISOString()
    };

    const headers = { Authorization: `Bearer ${token}`, "User-Agent": "netlify-fn" };
    const getUrl = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
    const resGet = await fetch(getUrl, { headers });

    if (resGet.status === 404) {
      // Crear data.json desde cero
      const contentB64 = Buffer.from(JSON.stringify([item], null, 2) + "\n").toString("base64");
      const putNew = await fetch(getUrl.replace(/\?ref=.*/, ""), {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message: `chore: create ${path} + add "${title}"`, content: contentB64, branch })
      });
      if (!putNew.ok) return err(`GitHub create error: ${putNew.status} ${await putNew.text()}`);
      return ok({ ok: true, created: true, id: item.id });
    }

    if (!resGet.ok) return err(`GitHub read error: ${resGet.status} ${await resGet.text()}`);
    const gh = await resGet.json();
    const sha = gh.sha;
    const current = JSON.parse(Buffer.from(gh.content, "base64").toString("utf8"));
    if (!Array.isArray(current)) return err("data.json must be an array", 500);

    const updated = [item, ...current];
    const contentB64 = Buffer.from(JSON.stringify(updated, null, 2) + "\n").toString("base64");
    const putUrl = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const putRes = await fetch(putUrl, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: `chore: add "${title}"`, content: contentB64, sha, branch })
    });
    if (!putRes.ok) return err(`GitHub write error: ${putRes.status} ${await putRes.text()}`);

    return ok({ ok: true, id: item.id });
  } catch (e) {
    console.error("[addProduct] fatal:", e);
    return err("Internal error", 500);
  }
};