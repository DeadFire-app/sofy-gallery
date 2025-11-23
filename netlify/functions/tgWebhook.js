const axios = require('axios');

// --- CONFIGURACIÓN Y VARIABLES DE ENTORNO ---
// Deben estar configuradas en Netlify
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main'; // Valor por defecto 'main'

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

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
        // console.error es clave para ver en los logs de Netlify
        console.error('Error enviando mensaje a Telegram:', error.response?.data?.description || error.message);
    }
}

// 2. Subir archivo a GitHub (La lógica principal)
async function uploadToGitHub(buffer, filename) {
    // 1. Convertir la imagen a Base64 para la API de GitHub
    const contentBase64 = buffer.toString('base64');
    const path = `images/${filename}`; // Ruta de la carpeta en el repo
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;

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

        // 2. Construir el LINK PERMANENTE (Raw)
        const rawLink = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${path}`;
        return rawLink;

    } catch (error) {
        // Errores de la API de GitHub (permisos, nombre duplicado, etc.)
        console.error('Error en la API de GitHub:', error.response?.data || error.message);
        const ghError = error.response?.data?.message || error.message;

        if (error.response?.status === 401 || error.response?.status === 403) {
             throw new Error(`Error de credenciales/permisos (Código ${error.response.status}). Revisa que el GITHUB_TOKEN sea válido y tenga permiso 'Contents: Read and write'.`);
        }
        if (error.response?.status === 409) {
            throw new Error(`El archivo con el nombre ${filename} ya existe en la rama ${GH_BRANCH}.`);
        }
        
        throw new Error(`Fallo desconocido de GitHub: ${ghError}`);
    }
}

// --- FUNCIÓN PRINCIPAL DE NETLIFY HANDLER ---
exports.handler = async (event) => {
    // Netlify (Lambda) requiere una respuesta HTTP 200 para confirmar la entrega a Telegram
    const successResponse = { statusCode: 200, body: 'OK' };

    // 1. Verificar si el método es POST y tiene cuerpo
    if (event.httpMethod !== 'POST' || !event.body) {
        return successResponse; 
    }
    
    // 2. Parsear el cuerpo del mensaje
    let update;
    try {
        update = JSON.parse(event.body);
    } catch (e) {
        console.error("Error al parsear el JSON del cuerpo:", e.message);
        return successResponse; // Fallo silencioso si no es JSON válido
    }

    if (!update.message) return successResponse;

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';

    try {
        // --- LÓGICA DE COMANDOS ---
        
        if (text.startsWith('/start')) {
            await sendMessage(chatId, "👋 ¡Hola! Envíame una imagen y la subiré a tu repositorio de GitHub para obtener un link permanente.");
            return successResponse;
        }

        if (text.startsWith('/listo')) {
            await sendMessage(chatId, "✅ Todo está operativo. Estoy esperando tu próximo comando o imagen.");
            return successResponse;
        }

        if (text.startsWith('/eliminar')) {
            await sendMessage(chatId, "⚠️ La eliminación de archivos es compleja en modo Serverless. Por ahora, realiza la eliminación directamente en GitHub.");
            return successResponse;
        }

        // --- LÓGICA DE IMÁGENES (Fotos de álbum o individuales) ---
        
        if (msg.photo && msg.photo.length > 0) {
            // Tomamos la imagen de mayor resolución
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;

            await sendMessage(chatId, "⏳ Recibida. Descargando y subiendo a GitHub...", msg.message_id);

            // 1. Obtener la ruta del archivo en Telegram
            const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
            const filePath = fileInfo.data.result.file_path;
            
            // Generar nombre único basado en el tiempo y extensión
            const extension = filePath.split('.').pop();
            const fileName = `${Date.now()}_${Math.floor(Math.random() * 9999)}.${extension}`;

            // 2. Descargar la imagen como ArrayBuffer
            const downloadUrl = `${TELEGRAM_FILE_API}/${filePath}`;
            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(imageResponse.data);

            // 3. Subir a GitHub y obtener el link permanente
            const permanentLink = await uploadToGitHub(buffer, fileName);

            // 4. Responder con el link
            await sendMessage(chatId, `✅ **Imagen Guardada Exitosamente**\n\n🔗 Link Permanente:\n${permanentLink}`, msg.message_id);
            return successResponse;
        }

    } catch (error) {
        // Si hay un error, lo registramos en los logs de Netlify
        console.error("Fallo durante la ejecución del Handler:", error.message);

        // Y le informamos al usuario
        await sendMessage(chatId, `❌ **ERROR**\nNo se pudo completar la actividad.\n\n**Razón:** ${error.message}`);
    }

    return successResponse;
};
