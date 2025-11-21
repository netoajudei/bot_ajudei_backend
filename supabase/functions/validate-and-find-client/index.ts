import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Função auxiliar para formatar o número de telefone
function formatarTelefone(ddd, numero) {
  let numeroLimpo = numero.replace(/\D/g, '');
  if (numeroLimpo.length === 9 && numeroLimpo.startsWith('9')) {
    numeroLimpo = numeroLimpo.substring(1);
  }
  if (numeroLimpo.length !== 8) {
    throw new Error("Formato de número inválido. O telefone deve ter 8 ou 9 dígitos.");
  }
  return `55${ddd}${numeroLimpo}`;
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // 1. Validação dos Parâmetros de Entrada
    const { ddd, telefone, empresa_id } = await req.json();
    if (isDebugMode) {
      console.log("📥 Payload recebido:", {
        ddd,
        telefone,
        empresa_id
      });
    }
    if (!ddd || !telefone || !empresa_id) {
      throw new Error("Dados incompletos. É necessário fornecer 'ddd', 'telefone' e 'empresa_id'.");
    }
    // 2. Inicialização
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 3. Formata o número
    const numeroFormatado = formatarTelefone(ddd, telefone);
    const chatId = `${numeroFormatado}@c.us`; // Formato padrão do banco
    if (isDebugMode) {
      console.log("📱 Número formatado:", numeroFormatado);
      console.log("💬 ChatId:", chatId);
    }
    // 4. PRIMEIRA VERIFICAÇÃO: Busca cliente existente no banco
    const { data: clienteExistente, error: selectError } = await supabaseClient.from('clientes').select('*').eq('chatId', chatId).eq('empresa_id', empresa_id).maybeSingle();
    if (selectError) {
      throw new Error(`Erro ao buscar cliente: ${selectError.message}`);
    }
    // Se o cliente já existe, retorna direto
    if (clienteExistente) {
      if (isDebugMode) {
        console.log(`✅ Cliente encontrado no banco: ID ${clienteExistente.id}`);
      }
      return new Response(JSON.stringify({
        success: true,
        cliente: clienteExistente
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 200
      });
    }
    // 5. Cliente não existe - Busca configurações da empresa
    if (isDebugMode) {
      console.log("🔍 Cliente não encontrado. Buscando configurações da empresa...");
    }
    const { data: empresaData, error: empresaError } = await supabaseClient.from('empresa').select(`
        instanciaChat,
        fantasia,
        api_provider,
        api_keys!inner(
          wa_me_key,
          whatsapp_phone_number_id,
          whatsapp_access_token
        )
      `).eq('id', empresa_id).single();
    if (empresaError || !empresaData) {
      throw new Error(`Empresa com ID ${empresa_id} não encontrada.`);
    }
    const { instanciaChat: instancia, fantasia, api_provider, api_keys } = empresaData;
    if (isDebugMode) {
      console.log(`🏢 Empresa: ${fantasia}`);
      console.log(`📡 API Provider: ${api_provider}`);
    }
    // 6. VALIDAÇÃO NO WHATSAPP - Escolhe a API correta
    let whatsappValido = false;
    let validationResponse = null;
    switch(api_provider){
      case 'wame':
        if (isDebugMode) console.log("🔄 Validando via WA.ME...");
        if (!api_keys.wa_me_key) {
          throw new Error("Chave da API wa.me não configurada para esta empresa.");
        }
        const wameUrl = `https://us.api-wa.me/${api_keys.wa_me_key}/contacts/${numeroFormatado}`;
        try {
          const wameResponse = await fetch(wameUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json'
            }
          });
          validationResponse = await wameResponse.json();
          whatsappValido = wameResponse.status === 200;
          if (isDebugMode) {
            console.log(`📊 Resposta WA.ME - Status: ${wameResponse.status}`);
            console.log(`📊 Válido: ${whatsappValido}`);
          }
        } catch (error) {
          console.error("❌ Erro na validação WA.ME:", error);
          throw new Error(`Erro ao validar número via wa.me: ${error.message}`);
        }
        break;
      case 'api_oficial':
        if (isDebugMode) console.log("🔄 Validando via API Oficial (Meta)...");
        if (!api_keys.whatsapp_phone_number_id || !api_keys.whatsapp_access_token) {
          throw new Error("Credenciais da API oficial do WhatsApp não configuradas.");
        }
        const metaUrl = `https://graph.facebook.com/v18.0/${api_keys.whatsapp_phone_number_id}`;
        try {
          // Tenta enviar uma mensagem de template ou verificar o número
          const metaResponse = await fetch(`${metaUrl}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${api_keys.whatsapp_access_token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: numeroFormatado,
              type: 'text',
              text: {
                body: 'Validação de número'
              }
            })
          });
          validationResponse = await metaResponse.json();
          // A API oficial retorna sucesso se o número é válido
          whatsappValido = metaResponse.status >= 200 && metaResponse.status < 300;
          if (isDebugMode) {
            console.log(`📊 Resposta API Oficial - Status: ${metaResponse.status}`);
            console.log(`📊 Válido: ${whatsappValido}`);
          }
        } catch (error) {
          console.error("❌ Erro na validação API Oficial:", error);
          throw new Error(`Erro ao validar número via API oficial: ${error.message}`);
        }
        break;
      case 'wappi':
      default:
        if (isDebugMode) console.log("🔄 Validando via WAPPI...");
        const wappiToken = '6kURwK0ywBRkUzYGxg07b2oSljzvpV3nClV6kFCeef6a4d58';
        if (!instancia) {
          throw new Error("Instância WAPPI não configurada para esta empresa.");
        }
        const waapiUrl = `https://waapi.app/api/v1/instances/${instancia}/client/action/get-number-id`;
        try {
          const waapiResponse = await fetch(waapiUrl, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Authorization': `Bearer ${wappiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              number: numeroFormatado
            })
          });
          validationResponse = await waapiResponse.json();
          whatsappValido = waapiResponse.ok && validationResponse?.data?.status !== 'error';
          if (isDebugMode) {
            console.log(`📊 Resposta WAPPI - Status: ${waapiResponse.status}`);
            console.log(`📊 Válido: ${whatsappValido}`);
          }
        } catch (error) {
          console.error("❌ Erro na validação WAPPI:", error);
          throw new Error(`Erro ao validar número via WAPPI: ${error.message}`);
        }
        break;
    }
    // 7. Verifica resultado da validação
    if (!whatsappValido) {
      if (isDebugMode) {
        console.log("❌ Número não registrado no WhatsApp");
      }
      throw new Error("Número de WhatsApp inválido ou não registrado.");
    }
    // 8. CRIA O CLIENTE no banco de dados
    if (isDebugMode) {
      console.log("✅ Número válido! Criando cliente no banco...");
    }
    const { data: novoCliente, error: insertError } = await supabaseClient.from('clientes').insert({
      chatId: chatId,
      empresa_id: empresa_id,
      empresa: fantasia,
      instancia: instancia,
      nome: `Cliente ${numeroFormatado}`
    }).select().single();
    if (insertError) {
      throw new Error(`Erro ao criar novo cliente: ${insertError.message}`);
    }
    if (isDebugMode) {
      console.log(`✅ Novo cliente criado com sucesso: ID ${novoCliente.id}`);
    }
    // 9. Retorna sucesso
    return new Response(JSON.stringify({
      success: true,
      cliente: novoCliente,
      validation_details: {
        api_provider: api_provider,
        whatsapp_valid: whatsappValido
      }
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('🔥 Erro na Edge Function validate-and-find-client:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 400
    });
  }
});
