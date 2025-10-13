// netlify/functions/github.js
// Utilidades para leer/actualizar data.json en GitHub (Contents API).
const OWNER  = process.env.GITHUB_OWNER;
const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PATH   = process.env.DATA_PATH || 'data.json';
const TOKEN  = process.env.GITHUB_TOKEN;

if (!OWNER || !REPO || !TOKEN) {
  console.warn('[github.js] Faltan variables de entorno GitHub.');
}

const GH_API = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function ghFetch(url, init = {}) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    ...init.headers
  };
  const res = await fetch(url, { ...init, headers });
  return res;
}

async function getDataJSON() {
  // GET /contents/{path}?ref={branch}
  const url = `${GH_API}/contents/${encodeURIComponent(PATH)}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await ghFetch(url);
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`GitHub get error: ${res.status} ${t}`);
  }
  const body = await res.json();
  const content = Buffer.from(body.content, body.encoding || 'base64').toString('utf8');
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    data = [];
  }
  // admitimos array directo o {items:[...]}
  const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  return { items, sha: body.sha, raw: data };
}

function ensureArrayModel(raw, items) {
  // devolvemos texto listo para subir (respetando formato original)
  if (Array.isArray(raw)) return JSON.stringify(items, null, 2);
  const obj = { ...(raw && typeof raw === 'object' ? raw : {}), items };
  return JSON.stringify(obj, null, 2);
}

async function putDataJSON({ items, sha, message }) {
  const content = Buffer.from(ensureArrayModel(null, items)).toString('base64');
  const url = `${GH_API}/contents/${encodeURIComponent(PATH)}`;
  const body = {
    message: message || 'update data.json',
    content,
    branch: BRANCH,
    sha
  };
  const res = await ghFetch(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`GitHub create error: ${res.status} ${t}`);
  }
  const json = await res.json();
  return json;
}

module.exports = {
  getDataJSON,
  putDataJSON,
};