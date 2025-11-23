// netlify/functions/deleteProduct.js
// POST protegido por x-api-key. Elimina (hard delete) o marca deleted=true por id.

const axios = require('axios'); // Usamos axios directamente para eliminar la dependencia local

// --- CONFIGURACIÓN DE ENTORNO (Debe estar en Netlify) ---
const API_KEY = process.env.API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GH_API = 'https://api.github.com';
const DATA_PATH = 'data/data.json';

// --- FUNCIONES AUXILIARES DE GITHUB (Autocontenidas) ---

function ghHeaders(token) {
  return { 
    'Authorization': `token ${token}`, 
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'DeleteProduct-Netlify-Function'
  };
}

// 1. Obtener datos (incluyendo SHA para actualización)
async function getDataJSON() {
    if (!GH_REPO || !GH_OWNER) throw new Error('GITHUB_REPO/OWNER not configured');
    if (!GH_TOKEN) throw new Error('GITHUB_TOKEN not configured');
    
    const apiPath = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(DATA_PATH)}?ref=${GH_BRANCH}`;

    try {
        const res = await axios.get(apiPath, { headers: ghHeaders(GH_TOKEN) });
        const j = res.data;

        const content = Buffer.from(j.content, 'base64').toString('utf8');
        let parsed;
        try { 
            parsed = JSON.parse(content); 
        } catch(e) { 
            parsed = { items: [] }; 
        }

        return { items: parsed.items || [], sha: j.sha };
    } catch (e) {
        // Manejar caso 404 (archivo no existe)
        if (e.response && e.response.status === 404) {
            console.warn('data.json not found, initializing empty.');
            return { items: [], sha: null };
        }
        throw new Error(`GitHub get failed: ${e.message || e}`);
    }
}

// 2. Subir/Actualizar datos (Requiere el SHA)
async function putDataJSON({ items, sha, message = 'update data.json via bot' }) {
    if (!GH_REPO || !GH_OWNER) throw new Error('GITHUB_REPO/OWNER not configured');
    if (!GH_TOKEN) throw new Error('GITHUB_TOKEN not configured');

    const apiPath = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(DATA_PATH)}`;
    const content = Buffer.from(JSON.stringify({ items }, null, 2)).toString('base64');
    
    const body = { message, content, branch: GH_BRANCH };
    if (sha) body.sha = sha;

    const res = await axios.put(apiPath, body, { headers: ghHeaders(GH_TOKEN) });
    
    if (!res.data) throw new Error(`GitHub put failed: ${res.status}`);
    return res.data;
}


// --- HANDLER PRINCIPAL (Lógica de eliminación original) ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok:false, error:'POST only' }) };
  }
  try {
    // 1. Autenticación
    if (!API_KEY) throw new Error('Missing API_KEY');
    const key = event.headers['x-api-key'] || event.headers['X-Api-Key'];
    if (key !== API_KEY) return { statusCode: 401, body: JSON.stringify({ ok:false, error:'Unauthorized' }) };

    // 2. Parseo y validación
    const payload = JSON.parse(event.body || '{}');
    const id = payload.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ ok:false, error:'falta id' }) };

    const hard = !!payload.hard;

    // 3. Obtener y actualizar
    const { items, sha } = await getDataJSON();
    let updated;
    if (hard) {
      updated = items.filter(x => String(x.id) !== String(id));
    } else {
      updated = items.map(x => String(x.id) === String(id) ? { ...x, deleted:true } : x);
    }

    // 4. Guardar cambios
    await putDataJSON({
      items: updated,
      sha,
      message: `delete: ${id} (${hard?'hard':'soft'})`,
    });

    return { statusCode: 200, body: JSON.stringify({ ok:true }) };
  } catch (err) {
    console.error('[deleteProduct] error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok:false, error:String(err.message||err) }) };
  }
};
