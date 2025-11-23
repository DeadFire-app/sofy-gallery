// netlify/functions/github.js
'use strict';
const fetch = global.fetch || require('node-fetch');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // formato: owner/repo, ej: usuario/repo
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GH_API = 'https://api.github.com';

function ghHeaders(){
  return { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' };
}

async function safeFetch(url, opts={}, retries=2){
  let last;
  for(let i=0;i<=retries;i++){
    try{ return await fetch(url, opts); }
    catch(err){ last = err; await new Promise(r=>setTimeout(r, 120 * Math.pow(2,i))); }
  }
  throw last;
}

async function downloadToBuffer(url, options = {}){
  const res = await safeFetch(url, { method:'GET' }, 2);
  if(!res.ok) throw new Error(`Download failed ${res.status}`);
  const maxBytes = options.maxBytes || (10 * 1024 * 1024);
  const arrayBuffer = await res.arrayBuffer();
  if(arrayBuffer.byteLength > maxBytes) throw new Error('File too large');
  return Buffer.from(arrayBuffer);
}

/**
 * uploadFileToRepo(url, path, options)
 * - url: URL pública (telegram getFile URL)
 * - path: ruta en repo, por ejemplo 'images/item.jpg' (puede incluir carpeta)
 * - options.maxBytes: límite de tamaño (opcional)
 */
async function uploadFileToRepo(url, path, options = {}){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO not configured');
  const buf = await downloadToBuffer(url, options);
  const content = buf.toString('base64');

  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  // comprobar si existe para obtener sha
  const getRes = await safeFetch(`${apiPath}?ref=${GITHUB_BRANCH}`, { method:'GET', headers: ghHeaders() }, 1).catch(()=>null);
  let body;
  if(getRes && getRes.ok){
    const getJson = await getRes.json();
    body = { message: `update ${path} via bot`, content, sha: getJson.sha, branch: GITHUB_BRANCH };
  } else {
    body = { message: `add ${path} via bot`, content, branch: GITHUB_BRANCH };
  }
  const putRes = await safeFetch(apiPath, { method:'PUT', headers: {...ghHeaders(), 'Content-Type':'application/json'}, body: JSON.stringify(body) }, 2);
  const putJson = await putRes.json();
  if(!putRes.ok) throw new Error(putJson && putJson.message ? putJson.message : `GitHub API error ${putRes.status}`);
  return putJson.content && putJson.content.path;
}

async function getDataJSON(){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO not configured');
  const path = 'data/data.json';
  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`;
  const res = await safeFetch(apiPath, { method:'GET', headers: ghHeaders() }, 2).catch(()=>null);
  if(!res || res.status === 404){
    // crear base si no existe
    await putDataJSON({ items: [], sha: null, message: 'init data.json' }).catch(()=>{});
    return { items: [], sha: null };
  }
  const j = await res.json();
  if(!res.ok) throw new Error(j && j.message ? j.message : `GitHub get failed ${res.status}`);
  const content = Buffer.from(j.content, 'base64').toString('utf8');
  let parsed;
  try{ parsed = JSON.parse(content); }catch(e){ parsed = { items: [] }; }
  return { items: parsed.items || [], sha: j.sha };
}

async function putDataJSON({ items, sha, message = 'update data.json via bot' }){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO not configured');
  const path = 'data/data.json';
  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const content = Buffer.from(JSON.stringify({ items }, null, 2)).toString('base64');
  const body = { message, content, branch: GITHUB_BRANCH };
  if(sha) body.sha = sha;
  const res = await safeFetch(apiPath, { method:'PUT', headers: {...ghHeaders(), 'Content-Type':'application/json'}, body: JSON.stringify(body) }, 2);
  const j = await res.json();
  if(!res.ok) throw new Error(j && j.message ? j.message : `GitHub put failed ${res.status}`);
  return j;
}

async function deleteFileFromRepo(path){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO not configured');
  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`;
  const getRes = await safeFetch(apiPath, { method:'GET', headers: ghHeaders() }, 2).catch(()=>null);
  if(!getRes || getRes.status === 404) return null;
  const getJson = await getRes.json();
  if(!getRes.ok) throw new Error(getJson && getJson.message ? getJson.message : `GitHub get failed ${getRes.status}`);
  const delBody = { message: `delete ${path} via bot`, sha: getJson.sha, branch: GITHUB_BRANCH };
  const delRes = await safeFetch(`${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`, { method:'DELETE', headers: {...ghHeaders(), 'Content-Type':'application/json'}, body: JSON.stringify(delBody) }, 2);
  const dj = await delRes.json();
  if(!delRes.ok) throw new Error(dj && dj.message ? dj.message : `GitHub delete failed ${delRes.status}`);
  return dj;
}

module.exports = {
  uploadFileToRepo,
  getDataJSON,
  putDataJSON,
  deleteFileFromRepo
};