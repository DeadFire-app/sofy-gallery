const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');

// --- CONFIGURACIÓN Y VARIABLES DE ENTORNO ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

const app = express();

// Middleware para procesar JSON de Telegram
app.use(express.json());

// --- FUNCIONES AUXILIARES ---

// 1. Enviar mensaje a Telegram
async function sendMessage(chatId, text, replyId = null) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: text,
            reply_to_message_id: replyId,
            parse_mode: 'Markdown' // Para que los links se vean bonitos
        });
    } catch (error) {
        console.error('Error enviando mensaje:', error.message);
    }
}

// 2. Subir archivo a GitHub (La magia del link eterno)
async function uploadToGitHub(buffer, filename) {
    const contentBase64 = buffer.toString('base64');
    const path = `images/${filename}`; // Carpeta images del repo
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;

    try {
        await axios.put(url, {
            message: `Subida automática: ${filename}`,
            content: contentBase64,
            branch: GH_BRANCH
        }, {
            headers: {
                'Authorization': `token ${GH_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'TelegramBot-Sofy' // GitHub requiere User-Agent
            }
        });

        // Construimos el LINK ETERNO (Raw)
        // Formato: https://raw.githubusercontent.com/USER/REPO/BRANCH/PATH
        const rawLink = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${path}`;
        return rawLink;

    } catch (error) {
        console.error('Error GitHub:', error.response?.data || error.message);
        if (error.response?.status === 409) throw new Error("El archivo ya existe.");
        if (error.response?.status === 401) throw new Error("Error de permisos (Token GitHub inválido).");
        if (error.response?.status === 404) throw new Error("Repositorio o carpeta no encontrada.");
        throw new Error(`Error desconocido de GitHub: ${error.message}`);
    }
}

// --- RUTA PRINCIPAL DEL WEBHOOK ---
app.post('/webhook', async (req, res) => {
    // Responder 200 OK rápido a Telegram para que no reintente
    res.status(200).send('OK');

    const update = req.body;
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';

    try {
        // --- LÓGICA DE COMANDOS ---
        
        if (text.startsWith('/start')) {
            return await sendMessage(chatId, "👋 ¡Hola! Envíame una imagen (o un álbum) y la subiré a tu repositorio generando un link permanente.");
        }

        if (text.startsWith('/listo')) {
            return await sendMessage(chatId, "✅ Todo está en orden. Sistema operativo.");
        }

        if (text.startsWith('/eliminar')) {
            // Como no tenemos base de datos, no podemos saber cuál fue la "última",
            // así que instruimos al usuario o pedimos nombre.
            return await sendMessage(chatId, "⚠️ Para eliminar una imagen, debes hacerlo manualmente desde tu repositorio de GitHub o enviarme el comando: `/eliminar nombre_archivo.jpg` (Aún en desarrollo).");
        }

        // --- LÓGICA DE IMÁGENES ---
        
        if (msg.photo && msg.photo.length > 0) {
            // Telegram envía varias calidades, tomamos la última (la mejor calidad)
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;

            // Avisar que estamos trabajando
            await sendMessage(chatId, "⏳ Descargando y subiendo a GitHub...", msg.message_id);

            // 1. Obtener la ruta del archivo en Telegram
            const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
            const filePath = fileInfo.data.result.file_path;
            
            // Generar nombre único: timestamp_random.jpg
            const extension = filePath.split('.').pop();
            const fileName = `${Date.now()}_${Math.floor(Math.random() * 1000)}.${extension}`;

            // 2. Descargar la imagen (como ArrayBuffer)
            const downloadUrl = `${TELEGRAM_FILE_API}/${filePath}`;
            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(imageResponse.data);

            // 3. Subir a GitHub
            const permanentLink = await uploadToGitHub(buffer, fileName);

            // 4. Responder con el link
            return await sendMessage(chatId, `✅ **Imagen Guardada**\n\n🔗 Link Permanente:\n${permanentLink}`, msg.message_id);
        }

    } catch (error) {
        console.error("Error general:", error);
        // Requisito: Enviar mensaje de por qué falló
        await sendMessage(chatId, `❌ **Error Crítico**\nNo se pudo completar la actividad.\n\n**Razón:** ${error.message}`);
    }
});

// Ruta base para verificar que el server vive
app.get('/', (req, res) => res.send('Bot activo. Configura el webhook a /webhook'));

// --- EXPORTAR PARA NETLIFY O LOCAL ---

// Si estamos en entorno local (Acode/PC) usamos app.listen
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_VERSION) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Servidor local corriendo en puerto ${PORT}`));
}

// Para Netlify Functions, exportamos el handler
module.exports.handler = serverless(app);
