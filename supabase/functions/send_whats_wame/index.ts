// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // --- 1. Validação dos Dados Recebidos ---
    // Esta função espera receber 'key', 'chatId' e 'message'.
    const { key, chatId, message } = await req.json();
    if (!key || !chatId || !message) {
      throw new Error("Dados incompletos. É necessário fornecer 'key', 'chatId' e 'message'.");
    }
    // --- 2. Preparação dos Dados ---
    // Garante que o chatId esteja limpo, removendo o sufixo @c.us se existir.
    const numeroLimpo = String(chatId).replace('@c.us', '');
    const apiUrl = `https://us.api-wa.me/${key}/message/text`;
    const apiPayload = {
      to: numeroLimpo,
      text: message
    };
    // --- 3. Envio da Mensagem ---
    console.log(`Enviando mensagem para ${numeroLimpo} usando a chave ${key}...`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(apiPayload)
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Erro ao enviar mensagem pela API api-wa.me: ${response.status} - ${errorBody}`);
    }
    const responseData = await response.json();
    console.log("Mensagem enviada com sucesso pela API externa:", responseData);
    // --- 4. Retorno de Sucesso ---
    return new Response(JSON.stringify({
      success: true,
      detail: responseData
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    // Captura qualquer erro no processo e retorna uma resposta clara.
    console.error('🔥 Erro na Edge Function send_whats_wame:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
