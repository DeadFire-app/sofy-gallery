/**
 * deleteProduct: elimina por id o por image URL
 * POST JSON: { id? , image? }
 * Auth opcional: header x-api-key == process.env.API_KEY
 */
const GH_API = "https://api.github.com";
const HJSON = { "Content-Type":"application/json; charset=utf-8" };
const HCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
};
const ok  =(o)=>({statusCode:200,headers:{...HJSON,...HCORS},body:JSON.stringify(o)});
const bad =(m)=>({statusCode:400,headers:{...HJSON,...HCORS},body:JSON.stringify({ok:false,error:m})});
const err =(m,s=500)=>({statusCode:s,headers:{...HJSON,...HCORS},body:JSON.stringify({ok:false,error:m})});
const clean=(s,max=1200)=>String(s||"").trim().slice(0,max);

exports.handler = async (event)=>{
  if (event.httpMethod==="OPTIONS") return {statusCode:204,headers:HCORS};
  if (event.httpMethod!=="POST")    return err("Only POST allowed",405);

  const REQ = process.env.API_KEY;
  if (REQ){
    const key = event.headers["x-api-key"] || event.headers["X-API-KEY"];
    if (key !== REQ) return err("Unauthorized",401);
  }

  try{
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo  = process.env.GITHUB_REPO;
    const path  = process.env.DATA_PATH || "data.json";
    const branch= "main";
    if (!token || !owner || !repo) return err("Missing owner/repo/token",500);

    const body = JSON.parse(event.body||"{}");
    const id    = body.id != null ? Number(body.id) : null;
    const image = body.image ? clean(body.image) : null;
    if (id==null && !image) return bad("Provide 'id' or 'image'");

    const headers = { Authorization:`Bearer ${token}`, "User-Agent":"netlify-fn" };
    const getUrl = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
    const getRes = await fetch(getUrl,{ headers });
    if (getRes.status===404) return err("data.json not found",404);
    if (!getRes.ok) return err(`GitHub read error: ${getRes.status} ${await getRes.text()}`);

    const gh = await getRes.json();
    const sha = gh.sha;
    const current = JSON.parse(Buffer.from(gh.content,"base64").toString("utf8"));
    if (!Array.isArray(current)) return err("data.json must be an array",500);

    let removed = 0, filtered = current;
    if (id!=null){
      const before = filtered.length;
      filtered = filtered.filter(x=>Number(x.id)!==id);
      removed = before - filtered.length;
    } else if (image){
      const before = filtered.length;
      filtered = filtered.filter(x=>String(x.image)!==String(image));
      removed = before - filtered.length;
    }

    if (removed===0) return err("No matching item found",404);

    const contentB64 = Buffer.from(JSON.stringify(filtered,null,2)+"\n").toString("base64");
    const putUrl = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const putRes = await fetch(putUrl,{
      method:"PUT", headers:{...headers,"Content-Type":"application/json"},
      body: JSON.stringify({ message:`chore: delete ${removed} item(s)`, content:contentB64, sha, branch })
    });
    if (!putRes.ok) return err(`GitHub write error: ${putRes.status} ${await putRes.text()}`);

    return ok({ ok:true, removedCount: removed });
  }catch(e){
    console.error("[deleteProduct] fatal:", e);
    return err("Internal error",500);
  }
};