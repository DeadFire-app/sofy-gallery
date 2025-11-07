// netlify/functions/addProduct.js
// POST protegido por x-api-key. Inserta un producto al inicio de data.json en GitHub.

const { getDataJSON, putDataJSON } = require('./github.js');

const API_KEY = process.env.API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok:false, error:'POST only' }) };
  }
  try {
    if (!API_KEY) throw new Error('Missing API_KEY');
    const key = event.headers['x-api-key'] || event.headers['X-Api-Key'];
    if (key !== API_KEY) return { statusCode: 401, body: JSON.stringify({ ok:false, error:'Unauthorized' }) };

    const data = JSON.parse(event.body || '{}');

    // Validaciones mínimas
    const title = (data.title || '').trim();
    const description = (data.description || '').trim();
    const images = Array.isArray(data.images) ? data.images.filter(Boolean) : (data.image ? [data.image] : []);
    const tags = Array.isArray(data.tags) ? data.tags : [];

    if (!title || !description || !images.length) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error:'faltan campos: title/description/images' }) };
    }

    const price = Number(data.price || 0) || 0;
    const id = Date.now();
    const product = {
      id,
      title,
      description,
      image: images[0],
      images,
      tags,
      price,
      createdAt: new Date().toISOString(),
    };

    const { items, sha } = await getDataJSON();
    const newItems = [product, ...items];
    await putDataJSON({
      items: newItems,
      sha,
      message: `add: ${title} (${id})`,
    });

    return { statusCode: 200, body: JSON.stringify({ ok:true, id }) };
  } catch (err) {
    console.error('[addProduct] error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok:false, error:String(err.message||err) }) };
  }
};