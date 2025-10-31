// Esta é a sua nova função "gateway". A sua única responsabilidade é
// receber um pedido padronizado e traduzi-lo para a API correta.
// VERSÃO ATUALIZADA: O wappi_token agora é estático, como solicitado.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    // 1. Recebe o payload padronizado e simplificado.
    const { cliente_id, message } = await req.json();
    if (!cliente_id || !message) {
      throw new Error("Dados incompletos. É necessário fornecer 'cliente_id' e 'message'.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. BUSCA INICIAL: Busca apenas os dados do cliente e da empresa.
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('chatId, empresa!inner(id, instanciaChat, api_provider)').eq('id', cliente_id).single();
    if (clienteError || !clienteData) {
      throw new Error(`Cliente ou empresa não encontrados para o cliente ID: ${cliente_id}.`);
    }
    const { chatId, empresa } = clienteData;
    const { id: empresa_id, instanciaChat: instancia, api_provider } = empresa;
    // 3. O "FORK": Decide qual API chamar e busca os dados específicos DENTRO de cada caso.
    let response;
    switch(api_provider){
      case 'wame':
        // Busca a chave específica para a 'wame'
        const { data: apiKeyWame, error: apiKeyWameError } = await supabaseClient.from('api_keys').select('wa_me_key').eq('empresa_id', empresa_id).single();
        if (apiKeyWameError || !apiKeyWame?.wa_me_key) {
          throw new Error(`A chave (key) da API 'wa.me' não está configurada para a empresa ID: ${empresa_id}.`);
        }
        const wa_me_key = apiKeyWame.wa_me_key;
        const numeroLimpo = String(chatId).replace('@c.us', '');
        const apiUrlWame = `https://us.api-wa.me/${wa_me_key}/message/text`;
        const payloadWame = {
          to: numeroLimpo,
          text: message
        };
        console.log(`Enviando via WA.ME para ${numeroLimpo}...`);
        response = await fetch(apiUrlWame, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(payloadWame)
        });
        break;
      case 'wappi':
        // *** ALTERAÇÃO APLICADA AQUI ***
        // O token da WAPPI agora é estático, como solicitado.
        const wappiToken = '6kURwK0ywBRkUzYGxg07b2oSljzvpV3nClV6kFCeef6a4d58';
        if (!instancia) throw new Error("A 'instancia' da WAPPI não está configurada para esta empresa.");
        const apiUrlWappi = `https://waapi.app/api/v1/instances/${instancia}/client/action/send-message`;
        const payloadWappi = {
          chatId,
          message
        };
        console.log(`Enviando via WAPPI para ${chatId} na instância ${instancia}...`);
        response = await fetch(apiUrlWappi, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${wappiToken}`
          },
          body: JSON.stringify(payloadWappi)
        });
        break;
      default:
        throw new Error(`Provedor de API desconhecido ou não configurado: '${api_provider}'`);
    }
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Erro ao enviar mensagem pela API '${api_provider}': ${response.status} - ${errorBody}`);
    }
    const responseData = await response.json();
    return new Response(JSON.stringify({
      success: true,
      detail: responseData
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('🔥 Erro no Gateway de Envio de Mensagens:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
