// Esta é a sua nova função "gateway" para notificações internas.
// Ela recebe um tipo de feedback e envia a mensagem para a lista de contatos correta.
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
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // 1. Recebe o payload padronizado.
    const { empresa_id, message, feedback_type } = await req.json();
    if (isDebugMode) console.warn(`▶️ [Gateway de Feedback] Iniciado com os parâmetros:`, {
      empresa_id,
      message,
      feedback_type
    });
    if (!empresa_id || !message || !feedback_type) {
      throw new Error("Dados incompletos. É necessário fornecer 'empresa_id', 'message' e 'feedback_type'.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Busca TODAS as configurações da empresa de uma só vez.
    const { data: empresaData, error: empresaError } = await supabaseClient.from('empresa').select('instanciaChat, api_provider, contato_respostas, contatoSoReserva, contato_vagas_de_emprego, contato_fornecedores, api_keys!inner(wa_me_key)').eq('id', empresa_id).single();
    if (empresaError || !empresaData) {
      throw new Error(`Configurações não encontradas para a empresa ID: ${empresa_id}`);
    }
    // 3. Seleciona a lista de contatos correta com base no 'feedback_type'.
    let contactList = [];
    switch(feedback_type){
      case 'contato_respostas':
        contactList = empresaData.contato_respostas;
        break;
      case 'contatoSoReserva':
        contactList = empresaData.contatoSoReserva;
        break;
      case 'contato_vagas_de_emprego':
        contactList = empresaData.contato_vagas_de_emprego;
        break;
      case 'contato_fornecedores':
        contactList = empresaData.contato_fornecedores;
        break;
      default:
        throw new Error(`Tipo de feedback desconhecido: '${feedback_type}'`);
    }
    if (!contactList || contactList.length === 0) {
      if (isDebugMode) console.warn(`Nenhum contato encontrado para o tipo de feedback '${feedback_type}'. Encerrando.`);
      return new Response(JSON.stringify({
        success: true,
        message: "Nenhum contato para notificar."
      }), {
        status: 200,
        headers: corsHeaders
      });
    }
    // 4. Itera sobre cada contato e tenta enviar a mensagem.
    for (const contactId of contactList){
      try {
        const { api_provider, instanciaChat: instancia, api_keys } = empresaData;
        const wa_me_key = api_keys.wa_me_key;
        let response;
        if (isDebugMode) console.warn(`... ⚙️ Processando contato ${contactId}. Provedor de API da empresa: '${api_provider}'`);
        switch(api_provider){
          case 'wame':
            if (!wa_me_key) throw new Error("A chave da API 'wa.me' não está configurada.");
            const numeroLimpo = String(contactId).replace('@c.us', '').replace('@g.us', '');
            const apiUrlWame = `https://us.api-wa.me/${wa_me_key}/message/text`;
            response = await fetch(apiUrlWame, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                to: numeroLimpo,
                text: message
              })
            });
            break;
          case 'wappi':
            // *** CORREÇÃO APLICADA AQUI: Busca o token dos secrets ***
            const wappiToken = Deno.env.get('WAAPI_TOKEN');
            if (!wappiToken) throw new Error("O secret 'WAPPI_TOKEN' não foi configurado para esta função.");
            if (!instancia) throw new Error("A instância da WAPPI não está configurada.");
            const apiUrlWappi = `https://waapi.app/api/v1/instances/${instancia}/client/action/send-message`;
            response = await fetch(apiUrlWappi, {
              method: 'POST',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${wappiToken}`
              },
              body: JSON.stringify({
                chatId: contactId,
                message
              })
            });
            break;
          default:
            throw new Error(`Provedor de API desconhecido: '${api_provider}'`);
        }
        if (!response.ok) {
          console.warn(`Falha ao enviar para o contato ${contactId}: ${response.status} - ${await response.text()}`);
        } else {
          if (isDebugMode) console.log(`✅ Sucesso! Mensagem enviada para o contato ${contactId}.`);
        }
      } catch (error) {
        console.error(`🔥 Falha! Erro ao processar o contato ${contactId}:`, error.message);
      }
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Notificações de feedback enviadas."
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (error) {
    console.error('🔥 Erro no Gateway de Feedback:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
