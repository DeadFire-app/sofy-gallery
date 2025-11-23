exports.handler = async (event) => {
    // Esto es un "ping" a Telegram: siempre debe devolver 200 OK.
    const successResponse = { statusCode: 200, body: 'OK' };

    try {
        // Log para saber que la función se ejecutó.
        console.log("FUNCIÓN INVOCADA. Intentando parsear JSON...");
        
        // Simplemente respondemos a Telegram
        const update = JSON.parse(event.body);
        const chatId = update.message.chat.id;

        // Si llega hasta aquí, significa que el JSON se parseó bien.
        
        const axios = require('axios');
        const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
        const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
        
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: "¡HOLA! La función ha respondido con éxito. El JSON se parseó correctamente."
        });
        
    } catch (error) {
        // Esto captura cualquier error de parseo o de la API de Telegram.
        console.error("ERROR CRÍTICO EN EL TEST:", error.message);
    }
    
    return successResponse; 
};
