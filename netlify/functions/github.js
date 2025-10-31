// netlify/functions/github.js
// Utilidades para leer/actualizar data.json y manejar imágenes en GitHub
const OWNER  = process.env.GITHUB_OWNER;
const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PATH   = process.env.DATA_PATH || 'data.json';
const TOKEN  = process.env.GITHUB_TOKEN;

if (!OWNER || !REPO || !TOKEN) console.warn('[github.js] Faltan variables de entorno GitHub.');

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

// ---------------- DATA.JSON ----------------

async function getDataJSON() {
  const url = `${GH_API}/contents/${encodeURIComponent(PATH)}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await ghFetch(url);
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`GitHub get error: ${res.status} ${t}`);
  }
  const body = await res.json();
  const content = Buffer.from(body.content, body.encoding || 'base64').toString('utf8');
  let data;
  try { data = JSON.parse(content); } catch { data = []; }
  const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  return { items, sha: body.sha, raw: data };
}

function ensureArrayModel(raw, items) {
  if (Array.isArray(raw)) return JSON.stringify(items, null, 2);
  const obj = { ...(raw && typeof raw === 'object' ? raw : {}), items };
  return JSON.stringify(obj, null, 2);
}

async function putDataJSON({ items, sha, message }) {
  const content = Buffer.from(ensureArrayModel(null, items)).toString('base64');
  const url = `${GH_API}/contents/${encodeURIComponent(PATH)}`;
  const body = { message: message || 'update data.json', content, branch: BRANCH, sha };
  const res = await ghFetch(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`GitHub create error: ${res.status} ${t}`);
  }
  return await res.json();
}

// ---------------- IMÁGENES ----------------

async function uploadFileToRepo(url, filename) {
  // Descarga la imagen del URL
  const resp = await fetch(url);
  if(!resp.ok) throw new Error(`No se pudo descargar imagen: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const content = Buffer.from(buffer).toString('base64');

  const path = `images/${filename}`;
  // Verificamos si ya existe para obtener SHA (PUT requiere SHA si existe)
  let sha = null;
  try {
    const check = await ghFetch(`${GH_API}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`);
    if (check.ok) { const body = await check.json(); sha = body.sha; }
  } catch {}

  const res = await ghFetch(`${GH_API}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message:`add image ${filename}`, content, branch:BRANCH, sha })
  });
  if(!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`GitHub upload error: ${res.status} ${t}`);
  }
  return filename;
}

async function deleteFileFromRepo(path) {
  try {
    const url = `${GH_API}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`;
    const res = await ghFetch(url);
    if(!res.ok) return; // no existe
    const body = await res.json();
    const sha = body.sha;
    const delRes = await ghFetch(`${GH_API}/contents/${encodeURIComponent(path)}`, {
      method:'DELETE',
      body: JSON.stringify({ message:`delete ${path}`, branch:BRANCH, sha })
    });
    if(!delRes.ok){
      const t = await delRes.text().catch(()=> '');
      throw new Error(`GitHub delete error: ${delRes.status} ${t}`);
    }
  } catch(err){ console.warn(`deleteFileFromRepo fail: ${err.message}`); }
}

module.exports = {
  getDataJSON,
  putDataJSON,
  uploadFileToRepo,
  deleteFileFromRepo,
};