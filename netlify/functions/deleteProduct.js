// netlify/functions/deleteProduct.js
// POST protegido por x-api-key. Elimina (hard delete) o marca deleted=true por id.

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

    const payload = JSON.parse(event.body || '{}');
    const id = payload.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ ok:false, error:'falta id' }) };

    const hard = !!payload.hard;

    const { items, sha } = await getDataJSON();
    let updated;
    if (hard) {
      updated = items.filter(x => String(x.id) !== String(id));
    } else {
      updated = items.map(x => String(x.id) === String(id) ? { ...x, deleted:true } : x);
    }

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