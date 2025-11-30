const axios = require('axios');

// --- CONFIGURACIÓN Y VARIABLES DE ENTORNO ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO = process.env.GITHUB_REPO;
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main'; 

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const GH_API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;

// Archivos de Persistencia
const GH_DATA_PATH = 'data.json'; // Listado de productos final
const GH_STATE_PATH = 'user_states.json'; // Almacén de estado conversacional (CRÍTICO)

// Headers comunes
const GH_HEADERS = {
    'Authorization': `token ${GH_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'TelegramBot-Netlify-Function'
};

// Opciones estáticas para el menú de telas
const FABRIC_OPTIONS = [
    { text: "Algodón Premium", data: "ALG_PREM" },
    { text: "Poliéster Dry-Fit", data: "POLI_DRY" },
    { text: "Lino Rústico", data: "LINO_RUST" },
    { text: "Seda Italiana", data: "SEDA_ITA" }
];

// --- FUNCIONES AUXILIARES DE GESTIÓN DE ESTADO (PERSISTENCIA EN GITHUB) ---

// 1. Leer estados conversacionales desde GitHub
async function getStatesFromGitHub() {
    const url = `${GH_API_BASE}/${GH_STATE_PATH}`;
    try {
        const { data } = await axios.get(url, { headers: GH_HEADERS });
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return {
            states: JSON.parse(content || '{}'), 
            sha: data.sha 
        };
    } catch (error) {
        if (error.response?.status === 404) {
            // Si el archivo no existe, retornamos un estado vacío
            return { states: {}, sha: null }; 
        }
        console.error('Error leyendo estados de GitHub:', error.message);
        throw new Error('Fallo al leer estado de GitHub');
    }
}

// 2. Guardar estados conversacionales en GitHub
async function saveStatesToGitHub(states, sha) {
    const url = `${GH_API_BASE}/${GH_STATE_PATH}`;
    const newContentBase64 = Buffer.from(JSON.stringify(states, null, 2)).toString('base64');
    
    const body = {
        message: '🔄 [BOT] Actualizando estados de conversación',
        content: newContentBase64,
        branch: GH_BRANCH
    };

    if (sha) {
        body.sha = sha; // Requerido si el archivo ya existe
    }

    try {
        await axios.put(url, body, { headers: GH_HEADERS });
    } catch (error) {
        console.error('Error guardando estados en GitHub:', error.response?.data || error.message);
        throw new Error('Fallo al guardar estado de GitHub. Posible conflicto de SHA.');
    }
}

// 3. Subir imagen a GitHub (images/)
async function uploadToGitHub(buffer, filename) {
    // ... (Tu función uploadToGitHub se mantiene, solo se usa GH_API_BASE) ...
    const contentBase64 = buffer.toString('base64');
    const path = `images/${filename}`; 
    const url = `${GH_API_BASE}/${path}`;

    try {
        await axios.put(url, {
            message: `📸 Nueva imagen: ${filename}`,
            content: contentBase64,
            branch: GH_BRANCH
        }, { headers: GH_HEADERS });

        const rawLink = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${path}`;
        return rawLink;

    } catch (error) {
        console.error('Error subiendo imagen a GitHub:', error.response?.data || error.message);
        throw new Error(`Fallo al subir imagen: ${error.message}`);
    }
}


// 4. Actualizar data.json (Añade un nuevo producto a un ARRAY)
async function updateJsonFile(newProductData) {
    const url = `${GH_API_BASE}/${GH_DATA_PATH}`;
    let sha = null;
    let currentDataArray = [];

    // 1. GET archivo actual
    try {
        const { data } = await axios.get(url, { headers: GH_HEADERS });
        sha = data.sha;
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        // Asumimos que data.json es un array de productos: []
        currentDataArray = JSON.parse(content);
    } catch (error) {
        // Ignoramos 404, si no existe empezamos con array vacío
        if (error.response?.status !== 404) throw error; 
    }

    // 2. Añadir nuevo producto
    currentDataArray.unshift(newProductData); // Añadir al inicio del array

    // 3. PUT el array actualizado
    const newContentBase64 = Buffer.from(JSON.stringify(currentDataArray, null, 2)).toString('base64');
    
    const body = {
        message: '➕ [BOT] Añadiendo nuevo producto',
        content: newContentBase64,
        branch: GH_BRANCH,
    };
    if (sha) body.sha = sha;

    try {
        await axios.put(url, body, { headers: GH_HEADERS });
    } catch (error) {
        console.error('Error actualizando data.json:', error.response?.data || error.message);
        throw new Error('Fallo al actualizar data.json');
    }
}

// 5. Enviar mensaje con Keyboard (botones)
async function sendFabricKeyboard(chatId, replyId) {
    const keyboard = FABRIC_OPTIONS.map(opt => ([{ 
        text: opt.text, 
        callback_data: `fabric_${opt.data}` // Prefijo para identificar la acción
    }]));

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '👕 Por favor, selecciona la **Tela** que deseas usar:',
        reply_to_message_id: replyId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

// 6. Enviar mensaje de texto
async function sendMessage(chatId, text, replyId = null, extra = {}) {
     // ... (Tu función sendMessage original) ...
     try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: text,
            reply_to_message_id: replyId,
            parse_mode: 'Markdown',
            ...extra
        });
    } catch (error) {
        console.error('Error enviando mensaje a Telegram:', error.response?.data?.description || error.message);
    }
}


// --- LÓGICA PRINCIPAL (STATE MACHINE) ---

async function handleNewProductFlow(chatId, currentStates, statesSha, msg, text, isCallback = false) {
    let userState = currentStates[chatId] || { step: 'IDLE', data: {} };
    let replyId = msg.message_id;

    // --- 1. IDLE (Inicio de flujo por IMAGEN) ---
    if (userState.step === 'IDLE' && msg.photo && !isCallback) {
        const photo = msg.photo[msg.photo.length - 1];
        
        // Guardar la data inicial y avanzar
        userState.data = { file_id: photo.file_id };
        userState.step = 'WAITING_FABRIC';
        currentStates[chatId] = userState;
        
        await saveStatesToGitHub(currentStates, statesSha);
        await sendFabricKeyboard(chatId, replyId);
        return;
    }
    
    // Si no estamos en un flujo, o si es un callback no válido, ignorar
    if (userState.step === 'IDLE') {
        if (!text.startsWith('/')) { // Ignorar texto que no es comando si estamos en IDLE
            await sendMessage(chatId, "👋 Por favor, envía una **imagen** para empezar un nuevo producto.", replyId);
        }
        return;
    }
    
    // --- 2. WAITING_FABRIC (Selección de tela por CALLBACK) ---
    if (userState.step === 'WAITING_FABRIC' && isCallback && text.startsWith('fabric_')) {
        const fabricData = text.replace('fabric_', '');
        const fabricName = FABRIC_OPTIONS.find(f => f.data === fabricData)?.text || 'Tela Desconocida';
        
        // Guardar la tela y avanzar
        userState.data.fabric = fabricName;
        userState.step = 'WAITING_SIZES';
        currentStates[chatId] = userState;
        
        await saveStatesToGitHub(currentStates, statesSha);
        
        await sendMessage(chatId, 
            `✅ Tela seleccionada: **${fabricName}**.\n\nAhora, por favor, ingresa los **talles** que estarán disponibles (ej: S, M, L, XL):`, 
            replyId
        );
        return;
    }
    
    // --- 3. WAITING_SIZES (Ingreso de talles por TEXTO) ---
    if (userState.step === 'WAITING_SIZES' && !isCallback && text) {
        // Guardar los talles y avanzar
        userState.data.sizes = text.trim();
        userState.step = 'WAITING_PRICE';
        currentStates[chatId] = userState;

        await saveStatesToGitHub(currentStates, statesSha);
        
        await sendMessage(chatId, 
            `✅ Talles guardados.\n\nFinalmente, ingresa el **precio** del producto (solo el número, ej: 15.50):`,
            replyId
        );
        return;
    }
    
    // --- 4. WAITING_PRICE (Ingreso de precio por TEXTO y FINALIZACIÓN) ---
    if (userState.step === 'WAITING_PRICE' && !isCallback && text) {
        const price = parseFloat(text.replace(/[^0-9.,]/g, '').replace(',', '.'));

        if (isNaN(price) || price <= 0) {
            await sendMessage(chatId, 
                `❌ El precio ingresado no es válido. Por favor, ingresa solo el número (ej: 15.50).`, 
                replyId
            );
            return; // No avanza de estado, pide reingreso
        }

        // --- INICIO DE PROCESO FINAL DE ALMACENAMIENTO ---
        await sendMessage(chatId, 
            `⏳ **PROCESANDO PRODUCTO...**\n1. Descargando Imagen.\n2. Subiendo a GitHub.\n3. Actualizando data.json.\n\nEsto puede tardar unos segundos.`, 
            replyId
        );

        try {
            // A. Descargar la imagen
            const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${userState.data.file_id}`);
            const filePath = fileInfo.data.result.file_path;
            const extension = filePath.split('.').pop();
            const fileName = `${Date.now()}.${extension}`;
            const downloadUrl = `${TELEGRAM_FILE_API}/${filePath}`;

            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(imageResponse.data);

            // B. Subir imagen a GitHub y obtener link
            const permanentLink = await uploadToGitHub(buffer, fileName);

            // C. Construir el objeto final
            const finalProduct = {
                id: Date.now(), // ID único para el producto
                imageUrl: permanentLink,
                fabric: userState.data.fabric,
                sizes: userState.data.sizes,
                price: price.toFixed(2), // Formatear a dos decimales
                dateAdded: new Date().toISOString()
            };

            // D. Actualizar data.json (Añadir nuevo producto al array)
            await updateJsonFile(finalProduct);

            // E. Limpiar estado
            delete currentStates[chatId];
            await saveStatesToGitHub(currentStates, statesSha);
            
            // F. Éxito final
            await sendMessage(chatId, 
                `✅ **¡PRODUCTO AÑADIDO!**\n\nEl producto con tela **${finalProduct.fabric}** y precio **$${finalProduct.price}** ha sido publicado en el sitio web.\n\n[Ver Imagen Directa](${finalProduct.imageUrl})`,
                replyId
            );

        } catch (error) {
            // Manejar errores durante el proceso final
            await sendMessage(chatId, `❌ **ERROR FATAL**\nNo se pudo finalizar el producto.\n\n_Detalle: ${error.message}_`);
            // Limpiar estado para evitar bucles
            delete currentStates[chatId];
            await saveStatesToGitHub(currentStates, statesSha);
        }

        return;
    }
}


// --- FUNCIÓN PRINCIPAL DE NETLIFY HANDLER ---
exports.handler = async (event) => {
    const successResponse = { statusCode: 200, body: 'OK' };
    if (event.httpMethod !== 'POST' || !event.body) return successResponse;
    
    let update;
    try {
        update = JSON.parse(event.body);
    } catch (e) {
        console.error("Error al parsear body:", e.message);
        return successResponse;
    }

    // Determinar si es un mensaje de texto/foto o un callback (botón)
    const isCallback = !!update.callback_query;
    const msg = isCallback ? update.callback_query.message : update.message;
    const data = isCallback ? update.callback_query.data : null;

    if (!msg) return successResponse;

    const chatId = msg.chat.id;
    const text = data || msg.text || '';
    
    try {
        // --- 1. Leer estado de GitHub (punto crítico) ---
        const { states: currentStates, sha: statesSha } = await getStatesFromGitHub();

        // --- 2. Manejar Comandos Básicos (Fuera del flujo de producto) ---
        if (text.startsWith('/start') && (!currentStates[chatId] || currentStates[chatId].step === 'IDLE')) {
            await sendMessage(chatId, "👋 ¡Hola! Envía una imagen para empezar a publicar un producto.");
            return successResponse;
        }

        // --- 3. Ejecutar Máquina de Estados ---
        await handleNewProductFlow(chatId, currentStates, statesSha, msg, text, isCallback);
        
        // Telegram requiere una respuesta para el callback si se usó un botón
        if (isCallback) {
            await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
                callback_query_id: update.callback_query.id,
                text: "Cargando siguiente paso..."
            });
        }

    } catch (error) {
        console.error("Fallo general durante la ejecución:", error.message);
        await sendMessage(chatId, `❌ **ERROR GRAVE**\nEl bot ha fallado inesperadamente. ${error.message}`);
    }

    return successResponse;
};
