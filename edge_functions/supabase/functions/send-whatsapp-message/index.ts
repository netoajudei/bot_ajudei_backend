// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// Define os cabeçalhos CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Inicia o servidor para escutar as requisições
serve(async (req)=>{
  // Lida com a requisição pre-flight do CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // --- 1. Validação dos Dados Recebidos ---
    const { chatId, message, instancia } = await req.json();
    if (!chatId || !message || !instancia) {
      throw new Error("Dados incompletos. É necessário fornecer 'chatId', 'message' e 'instancia'.");
    }
    // --- 2. Conexão com Supabase e Busca de Segredos ---
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const waapiToken = Deno.env.get('WAAPI_TOKEN');
    if (!waapiToken) {
      throw new Error("O segredo WAAPI_TOKEN não foi configurado para esta função.");
    }
    // Inicializa o cliente Supabase para poder inserir no banco
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 3. Preparação da Chamada para a API waapi.app ---
    const apiUrl = `https://waapi.app/api/v1/instances/${instancia}/client/action/send-message`;
    const apiPayload = {
      chatId,
      message
    };
    // --- 4. Envio da Mensagem ---
    console.log(`Enviando mensagem para ${chatId} na instância ${instancia}...`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${waapiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(apiPayload)
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Erro ao enviar mensagem pela API waapi.app: ${response.status} - ${errorBody}`);
    }
    const responseData = await response.json();
    console.log("Mensagem enviada com sucesso pela API externa:", responseData);
    // --- 5. LÓGICA ADICIONADA: Inserir a mensagem enviada no banco de dados ---
    const dataToInsert = {
      chatId: chatId,
      instancia: instancia,
      mensagem: message,
      tsData: new Date().toISOString(),
      type: 'chat',
      enviado_pelo_operador: true // Marca que esta mensagem foi enviada pela equipe
    };
    const { error: insertError } = await supabaseClient.from('chatsZap').insert(dataToInsert);
    if (insertError) {
      // Loga o erro, mas não para a função, pois a mensagem principal já foi enviada.
      console.error(`Erro ao salvar a mensagem enviada no chatsZap: ${insertError.message}`);
    } else {
      console.log("Registro da mensagem enviada salvo com sucesso no chatsZap.");
    }
    // --- 6. Retorno de Sucesso ---
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
    console.error('Erro na Edge Function send-whatsapp-message:', error);
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
