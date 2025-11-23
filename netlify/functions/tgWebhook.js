const axios = require('axios');

// --- CONFIGURACIÓN Y VARIABLES DE ENTORNO ---
// NOTA: Estas variables deben estar en el panel de Netlify
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main'; // Rama por defecto

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const GH_ENDPOINT = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/images`;

// --- FUNCIONES AUXILIARES ---

// 1. Enviar mensaje a Telegram
async function sendMessage(chatId, text, replyId = null) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: text,
            reply_to_message_id: replyId,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error('Error enviando mensaje a Telegram:', error.response?.data?.description || error.message);
    }
}

// 2. Subir archivo a GitHub (El link eterno)
async function uploadToGitHub(buffer, filename) {
    const contentBase64 = buffer.toString('base64');
    const path = `${filename}`; // Ya GH_ENDPOINT incluye la carpeta images
    const url = `${GH_ENDPOINT}/${path}`;

    try {
        await axios.put(url, {
            message: `Subida automática por bot: ${filename}`,
            content: contentBase64,
            branch: GH_BRANCH
        }, {
            headers: {
                'Authorization': `token ${GH_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'TelegramBot-Netlify-Function'
            }
        });

        // Construir el LINK PERMANENTE (Raw)
        const rawLink = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/images/${path}`;
        return rawLink;

    } catch (error) {
        console.error('Error en la API de GitHub:', error.response?.data || error.message);
        
        if (error.response?.status === 401 || error.response?.status === 403) {
             throw new Error(`Error de credenciales/permisos. Revisa que el GITHUB_TOKEN sea válido y tenga permiso 'Contents: Read and write'.`);
        }
        if (error.response?.status === 404) {
             throw new Error(`Repositorio no encontrado. Revisa GITHUB_OWNER y GITHUB_REPO.`);
        }
        
        throw new Error(`Fallo desconocido de GitHub: ${error.message}`);
    }
}

// --- FUNCIÓN PRINCIPAL DE NETLIFY HANDLER ---
exports.handler = async (event) => {
    const successResponse = { statusCode: 200, body: 'OK' };

    if (event.httpMethod !== 'POST' || !event.body) {
        return successResponse; 
    }
    
    let update;
    try {
        update = JSON.parse(event.body);
    } catch (e) {
        console.error("Error al parsear el JSON del cuerpo:", e.message);
        return successResponse;
    }

    if (!update.message) return successResponse;

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';

    try {
        // --- LÓGICA DE COMANDOS ---
        
        if (text.startsWith('/start')) {
            await sendMessage(chatId, "👋 ¡Hola! Soy tu bot de almacenamiento. Envíame una imagen y la subiré a GitHub generando un link permanente.");
            return successResponse;
        }

        if (text.startsWith('/listo')) {
            await sendMessage(chatId, "✅ Todo está operativo.");
            return successResponse;
        }

        if (text.startsWith('/eliminar')) {
            await sendMessage(chatId, "⚠️ La función de eliminación está deshabilitada temporalmente. Por favor, elimina archivos directamente desde tu repositorio de GitHub.");
            return successResponse;
        }

        // --- LÓGICA DE IMÁGENES ---
        
        if (msg.photo && msg.photo.length > 0) {
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;

            await sendMessage(chatId, "⏳ Recibida. Descargando y subiendo a GitHub...", msg.message_id);

            // 1. Obtener la ruta del archivo en Telegram
            const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
            const filePath = fileInfo.data.result.file_path;
            
            // Generar nombre único basado en el tiempo y extensión
            const extension = filePath.split('.').pop();
            const fileName = `${Date.now()}_${Math.floor(Math.random() * 9999)}.${extension}`;

            // 2. Descargar la imagen
            const downloadUrl = `${TELEGRAM_FILE_API}/${filePath}`;
            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(imageResponse.data);

            // 3. Subir a GitHub
            const permanentLink = await uploadToGitHub(buffer, fileName);

            // 4. Responder con el link
            await sendMessage(chatId, `✅ **Imagen Guardada Exitosamente**\n\n🔗 [Ver Imagen](${permanentLink})`, msg.message_id);
            return successResponse;
        }

    } catch (error) {
        console.error("Fallo durante la ejecución del Handler:", error.message);
        await sendMessage(chatId, `❌ **ERROR**\nNo se pudo completar la actividad.\n\n**Razón:** ${error.message}`);
    }

    return successResponse;
};
