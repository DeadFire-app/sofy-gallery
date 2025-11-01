// Diagnóstico de GitHub para Netlify Functions.
// NO escribe nada: solo prueba permisos, repo, rama y data.json.
// Uso desde el navegador:
//   https://<tu-sitio>.netlify.app/.netlify/functions/gh-diagnose
//
// Si querés testear otra rama o path:
//   .../gh-diagnose?branch=master&path=data.json

export async function handler(event) {
  const token  = process.env.GITHUB_TOKEN || "";
  const owner  = process.env.GITHUB_OWNER || "";
  const repo   = process.env.GITHUB_REPO  || "";
  const path   = (event.queryStringParameters?.path || process.env.DATA_PATH || "data.json");
  const branch = (event.queryStringParameters?.branch || process.env.GITHUB_BRANCH || "main");

  const headers = token ? { Authorization:`Bearer ${token}`, "User-Agent":"netlify-diag" } : {};
  const out = {
    envs: {
      has_GITHUB_TOKEN: !!token,
      GITHUB_OWNER: owner || null,
      GITHUB_REPO: repo || null,
      DATA_PATH: path || null,
      GITHUB_BRANCH: branch || null
    },
    checks: {}
  };

  // 0) Falta token?
  if (!token) {
    out.error = "Missing GITHUB_TOKEN";
    return json(200, out);
  }
  if (!owner || !repo) {
    out.error = "Missing GITHUB_OWNER or GITHUB_REPO";
    return json(200, out);
  }

  // 1) Repo info
  const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const repoRes = await safeFetch(repoUrl, { headers });
  out.checks.repo = await dump(repoRes);

  // 2) Branch (ref) info
  const refUrl = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  const refRes = await safeFetch(refUrl, { headers });
  out.checks.ref = await dump(refRes);

  // 3) Contents (data.json) info
  const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const fileRes = await safeFetch(fileUrl, { headers });
  out.checks.contents = await dump(fileRes);

  return json(200, out);
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(body, null, 2)
  };
}

async function safeFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    return { ok:false, status:-1, _error:String(e), json: async()=>({}), text: async()=>String(e) };
  }
}

async function dump(res) {
  if (!res) return { ok:false, status:-1, error:"no response" };
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { ok: !!res.ok, status: res.status ?? -1, body: parsed || text };
}