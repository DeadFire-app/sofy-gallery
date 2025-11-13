// github.js
'use strict';
/**
 * Funciones para interactuar con GitHub repo: uploadFileToRepo, getDataJSON, putDataJSON, deleteFileFromRepo
 * Requiere env:
 * - GITHUB_TOKEN (personal access token con repo permissions)
 * - GITHUB_REPO (owner/repo) e.g. "username/reponame"
 * - GITHUB_BRANCH (branch a usar, ej "main")
 */

const fetch = global.fetch || require('node-fetch');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if(!GITHUB_TOKEN) console.warn('[github] GITHUB_TOKEN not set');
if(!GITHUB_REPO) console.warn('[github] GITHUB_REPO not set');

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

// download URL to buffer (used to upload images to repo)
// options: { maxBytes } to limit size
async function downloadToBuffer(url, options = {}){
  const res = await safeFetch(url, { method:'GET' }, 2);
  if(!res.ok) throw new Error(`Download failed ${res.status}`);
  const maxBytes = options.maxBytes || (6 * 1024 * 1024);
  const arrayBuffer = await res.arrayBuffer();
  if(arrayBuffer.byteLength > maxBytes) throw new Error('File too large');
  return Buffer.from(arrayBuffer);
}

// uploadFileToRepo(url, pathInRepo, options)
async function uploadFileToRepo(url, path, options = {}){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO missing');
  // download file
  const buf = await downloadToBuffer(url, options);
  const content = buf.toString('base64');

  // check if file exists to either create or update
  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const getRes = await safeFetch(`${apiPath}?ref=${GITHUB_BRANCH}`, { method:'GET', headers: ghHeaders() }, 1);
  let body;
  if(getRes.status === 200){
    const getJson = await getRes.json();
    // update existing
    body = {
      message: `update ${path} via bot`,
      content,
      sha: getJson.sha,
      branch: GITHUB_BRANCH
    };
  } else {
    // create new
    body = {
      message: `add ${path} via bot`,
      content,
      branch: GITHUB_BRANCH
    };
  }
  const putRes = await safeFetch(apiPath, { method:'PUT', headers: {...ghHeaders(), 'Content-Type':'application/json'}, body: JSON.stringify(body) }, 2);
  const j = await putRes.json();
  if(!putRes.ok) throw new Error(j && j.message ? j.message : `GitHub put failed ${putRes.status}`);
  return j;
}

// getDataJSON: expects file at data/data.json
async function getDataJSON(){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO missing');
  const path = 'data/data.json';
  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`;
  const res = await safeFetch(apiPath, { method:'GET', headers: ghHeaders() }, 2);
  if(res.status === 404){
    // create empty data.json
    const empty = { items: [] };
    await putDataJSON({ items: [], sha: null, message: 'init data.json' });
    return { items: [], sha: null };
  }
  const j = await res.json();
  if(!res.ok) throw new Error(j && j.message ? j.message : `GitHub get failed ${res.status}`);
  const content = Buffer.from(j.content, 'base64').toString('utf8');
  let parsed;
  try{ parsed = JSON.parse(content); }catch(e){ parsed = { items: [] }; }
  return { items: parsed.items || [], sha: j.sha };
}

// putDataJSON: { items, sha, message }
async function putDataJSON({ items, sha, message = 'update data.json via bot' }){
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO missing');
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
  if(!GITHUB_REPO) throw new Error('GITHUB_REPO missing');
  // need sha
  const apiPath = `${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${GITHUB_BRANCH}`;
  const getRes = await safeFetch(apiPath, { method:'GET', headers: ghHeaders() }, 2);
  if(getRes.status === 404) return { ok:true, note:'not found' };
  const getJson = await getRes.json();
  if(!getRes.ok) throw new Error(getJson && getJson.message ? getJson.message : `GitHub get failed ${getRes.status}`);
  const delBody = { message: `delete ${path} via bot`, sha: getJson.sha, branch: GITHUB_BRANCH };
  const delRes = await safeFetch(`${GH_API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`, { method:'DELETE', headers: {...ghHeaders(),'Content-Type':'application/json'}, body: JSON.stringify(delBody) }, 2);
  const j = await delRes.json();
  if(!delRes.ok) throw new Error(j && j.message ? j.message : `GitHub delete failed ${delRes.status}`);
  return j;
}

module.exports = {
  uploadFileToRepo,
  getDataJSON,
  putDataJSON,
  deleteFileFromRepo
};