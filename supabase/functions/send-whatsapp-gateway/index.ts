// Gateway de Envio de Mensagens - Versão com API Oficial do WhatsApp
// IMPORTANTE: Todos os tokens são buscados da tabela api_keys (cada empresa tem o seu)
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
    // 1. Recebe o payload padronizado
    const { cliente_id, message } = await req.json();
    if (!cliente_id || !message) {
      throw new Error("Dados incompletos. É necessário fornecer 'cliente_id' e 'message'.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Busca dados do cliente e da empresa
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('chatId, empresa!inner(id, instanciaChat, api_provider)').eq('id', cliente_id).single();
    if (clienteError || !clienteData) {
      throw new Error(`Cliente ou empresa não encontrados para o cliente ID: ${cliente_id}.`);
    }
    const { chatId, empresa } = clienteData;
    const { id: empresa_id, instanciaChat: instancia, api_provider } = empresa;
    console.log(`📤 Enviando mensagem via ${api_provider} para cliente ${cliente_id}`);
    // 3. Roteamento para a API correta
    let response;
    switch(api_provider){
      case 'wame':
        {
          // ============================================
          // API: WA.ME
          // ============================================
          const { data: apiKey, error: apiKeyError } = await supabaseClient.from('api_keys').select('wa_me_key').eq('empresa_id', empresa_id).single();
          if (apiKeyError || !apiKey?.wa_me_key) {
            throw new Error(`A chave da API 'wa.me' não está configurada para a empresa ID: ${empresa_id}.`);
          }
          const wa_me_key = apiKey.wa_me_key;
          const numeroLimpo = String(chatId).replace('@c.us', '').replace('@s.whatsapp.net', '');
          const apiUrl = `https://us.api-wa.me/${wa_me_key}/message/text`;
          console.log(`📱 WA.ME → ${numeroLimpo}`);
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              to: numeroLimpo,
              text: message
            })
          });
          break;
        }
      case 'wappi':
        {
          // ============================================
          // API: WAPPI
          // ============================================
          const wappiToken = '6kURwK0ywBRkUzYGxg07b2oSljzvpV3nClV6kFCeef6a4d58';
          if (!instancia) {
            throw new Error("A 'instancia' da WAPPI não está configurada para esta empresa.");
          }
          const apiUrl = `https://waapi.app/api/v1/instances/${instancia}/client/action/send-message`;
          console.log(`📱 WAPPI → ${chatId} (instância: ${instancia})`);
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${wappiToken}`
            },
            body: JSON.stringify({
              chatId,
              message
            })
          });
          break;
        }
      case 'api_oficial':
        {
          // ============================================
          // API: WHATSAPP BUSINESS API OFICIAL (META/FACEBOOK)
          // ============================================
          // IMPORTANTE: Busca o token da tabela api_keys (cada empresa tem o seu)
          const { data: apiKey, error: apiKeyError } = await supabaseClient.from('api_keys').select('whatsapp_phone_number_id, whatsapp_access_token').eq('empresa_id', empresa_id).single();
          if (apiKeyError || !apiKey) {
            throw new Error(`Erro ao buscar credenciais da API Oficial para empresa ID: ${empresa_id}. ` + `Erro: ${apiKeyError?.message || 'Registro não encontrado'}`);
          }
          if (!apiKey.whatsapp_phone_number_id || !apiKey.whatsapp_access_token) {
            throw new Error(`Credenciais incompletas da API Oficial para empresa ID: ${empresa_id}. ` + `Certifique-se de preencher 'whatsapp_phone_number_id' e 'whatsapp_access_token' na tabela api_keys.`);
          }
          const phoneNumberId = apiKey.whatsapp_phone_number_id;
          const accessToken = apiKey.whatsapp_access_token;
          // Remove sufixos do chatId para obter apenas o número
          const numeroCliente = String(chatId).replace('@c.us', '').replace('@s.whatsapp.net', '');
          // Valida formato do número (deve ter país + DDD + número)
          if (!/^\d{10,15}$/.test(numeroCliente)) {
            throw new Error(`Formato de número inválido: ${numeroCliente}. ` + `O número deve conter apenas dígitos (país + DDD + número), entre 10 e 15 caracteres.`);
          }
          const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
          console.log(`📱 API OFICIAL → ${numeroCliente} (Phone ID: ${phoneNumberId})`);
          // 1. Envia "digitando..." antes da mensagem
          console.log(`⌨️ Enviando indicador de digitação...`);
          await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: numeroCliente,
              type: 'typing',
              typing: {
                status: 'typing'
              }
            })
          }).catch((err)=>console.warn('⚠️ Erro ao enviar typing indicator:', err));
          // Pequeno delay para parecer mais natural (opcional)
          await new Promise((resolve)=>setTimeout(resolve, 1000));
          // 2. Envia a mensagem de verdade
          console.log(`💬 Enviando mensagem...`);
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: numeroCliente,
              type: 'text',
              text: {
                preview_url: false,
                body: message
              }
            })
          });
          break;
        }
      default:
        throw new Error(`Provedor de API desconhecido: '${api_provider}'. ` + `Valores válidos: 'wappi', 'wame', 'api_oficial'`);
    }
    // 4. Verifica a resposta
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ Erro na API ${api_provider}:`, errorBody);
      throw new Error(`Erro ao enviar mensagem pela API '${api_provider}': ${response.status} - ${errorBody}`);
    }
    const responseData = await response.json();
    console.log(`✅ Mensagem enviada com sucesso via ${api_provider}`);
    return new Response(JSON.stringify({
      success: true,
      provider: api_provider,
      detail: responseData
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('🔥 Erro no Gateway de Envio de Mensagens:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
