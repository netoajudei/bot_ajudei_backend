import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
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
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // ========== ETAPA 1: VALIDAÇÃO DO PAYLOAD ==========
    if (isDebugMode) console.log("🚀 [ETAPA 1] Iniciando send-whatsapp-message...");
    const { chatId, message, instancia } = await req.json();
    if (isDebugMode) {
      console.log("📥 [ETAPA 1] Payload recebido:", {
        chatId,
        messagePreview: message?.substring(0, 50) + '...',
        instancia
      });
    }
    if (!chatId || !message || !instancia) {
      throw new Error("Dados incompletos. É necessário fornecer 'chatId', 'message' e 'instancia'.");
    }
    if (isDebugMode) console.log("✅ [ETAPA 1] Validação do payload OK");
    // ========== ETAPA 2: INICIALIZAÇÃO DO SUPABASE ==========
    if (isDebugMode) console.log("🔧 [ETAPA 2] Inicializando Supabase...");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas.");
    }
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    if (isDebugMode) console.log("✅ [ETAPA 2] Supabase inicializado");
    // ========== ETAPA 3: BUSCAR EMPRESA PELA INSTÂNCIA ==========
    if (isDebugMode) console.log("🔍 [ETAPA 3] Buscando empresa pela instância:", instancia);
    const { data: empresaData, error: empresaError } = await supabaseClient.from('empresa').select(`
        id,
        fantasia,
        api_provider,
        api_keys!inner(
          wa_me_key,
          whatsapp_phone_number_id,
          whatsapp_access_token
        )
      `).eq('instanciaChat', instancia).single();
    if (empresaError || !empresaData) {
      console.error("❌ [ETAPA 3] Erro ao buscar empresa:", empresaError);
      throw new Error(`Empresa não encontrada para a instância: ${instancia}`);
    }
    const { id: empresa_id, fantasia, api_provider, api_keys } = empresaData;
    if (isDebugMode) {
      console.log("✅ [ETAPA 3] Empresa encontrada:");
      console.log(`   - ID: ${empresa_id}`);
      console.log(`   - Nome: ${fantasia}`);
      console.log(`   - API Provider: ${api_provider}`);
    }
    // ========== ETAPA 4: PREPARAR DADOS CONFORME O PROVIDER ==========
    if (isDebugMode) console.log(`📡 [ETAPA 4] Preparando envio via ${api_provider}...`);
    let apiResponse;
    let numeroLimpo = chatId.replace('@c.us', '').replace('@s.whatsapp.net', '');
    switch(api_provider){
      // ==================== CASO 1: WA.ME ====================
      case 'wame':
        if (isDebugMode) console.log("🔵 [ETAPA 4.1] Usando API WA.ME");
        if (!api_keys.wa_me_key) {
          throw new Error("Chave wa_me_key não configurada para esta empresa.");
        }
        const wameUrl = `https://us.api-wa.me/${api_keys.wa_me_key}/message/text`;
        const wamePayload = {
          to: numeroLimpo,
          text: message
        };
        if (isDebugMode) {
          console.log(`   - URL: ${wameUrl}`);
          console.log(`   - Número: ${numeroLimpo}`);
          console.log(`   - Mensagem (preview): ${message.substring(0, 30)}...`);
        }
        if (isDebugMode) console.log("📤 [ETAPA 4.1] Enviando requisição para WA.ME...");
        apiResponse = await fetch(wameUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(wamePayload)
        });
        if (isDebugMode) {
          console.log(`   - Status HTTP: ${apiResponse.status}`);
        }
        if (!apiResponse.ok) {
          const errorBody = await apiResponse.text();
          console.error("❌ [ETAPA 4.1] Erro na resposta WA.ME:", errorBody);
          throw new Error(`Erro ao enviar via wa.me: ${apiResponse.status} - ${errorBody}`);
        }
        if (isDebugMode) console.log("✅ [ETAPA 4.1] Mensagem enviada via WA.ME com sucesso");
        break;
      // ==================== CASO 2: API OFICIAL (META) ====================
      case 'api_oficial':
        if (isDebugMode) console.log("🟢 [ETAPA 4.2] Usando API Oficial (Meta)");
        if (!api_keys.whatsapp_phone_number_id || !api_keys.whatsapp_access_token) {
          throw new Error("Credenciais da API oficial (phone_number_id ou access_token) não configuradas.");
        }
        const metaUrl = `https://graph.facebook.com/v18.0/${api_keys.whatsapp_phone_number_id}/messages`;
        const metaPayload = {
          messaging_product: 'whatsapp',
          to: numeroLimpo,
          type: 'text',
          text: {
            body: message
          }
        };
        if (isDebugMode) {
          console.log(`   - URL: ${metaUrl}`);
          console.log(`   - Phone Number ID: ${api_keys.whatsapp_phone_number_id}`);
          console.log(`   - Número: ${numeroLimpo}`);
          console.log(`   - Mensagem (preview): ${message.substring(0, 30)}...`);
        }
        if (isDebugMode) console.log("📤 [ETAPA 4.2] Enviando requisição para API Oficial...");
        apiResponse = await fetch(metaUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${api_keys.whatsapp_access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(metaPayload)
        });
        if (isDebugMode) {
          console.log(`   - Status HTTP: ${apiResponse.status}`);
        }
        if (!apiResponse.ok) {
          const errorBody = await apiResponse.text();
          console.error("❌ [ETAPA 4.2] Erro na resposta API Oficial:", errorBody);
          throw new Error(`Erro ao enviar via API oficial: ${apiResponse.status} - ${errorBody}`);
        }
        if (isDebugMode) console.log("✅ [ETAPA 4.2] Mensagem enviada via API Oficial com sucesso");
        break;
      // ==================== CASO 3: WAPPI (PADRÃO/LEGADO) ====================
      case 'wappi':
      default:
        if (isDebugMode) console.log("🟡 [ETAPA 4.3] Usando API WAPPI (padrão)");
        const wappiToken = '6kURwK0ywBRkUzYGxg07b2oSljzvpV3nClV6kFCeef6a4d58';
        const wappiUrl = `https://waapi.app/api/v1/instances/${instancia}/client/action/send-message`;
        const wappiPayload = {
          chatId,
          message
        };
        if (isDebugMode) {
          console.log(`   - URL: ${wappiUrl}`);
          console.log(`   - Instância: ${instancia}`);
          console.log(`   - ChatId: ${chatId}`);
          console.log(`   - Mensagem (preview): ${message.substring(0, 30)}...`);
        }
        if (isDebugMode) console.log("📤 [ETAPA 4.3] Enviando requisição para WAPPI...");
        apiResponse = await fetch(wappiUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${wappiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(wappiPayload)
        });
        if (isDebugMode) {
          console.log(`   - Status HTTP: ${apiResponse.status}`);
        }
        if (!apiResponse.ok) {
          const errorBody = await apiResponse.text();
          console.error("❌ [ETAPA 4.3] Erro na resposta WAPPI:", errorBody);
          throw new Error(`Erro ao enviar via WAPPI: ${apiResponse.status} - ${errorBody}`);
        }
        if (isDebugMode) console.log("✅ [ETAPA 4.3] Mensagem enviada via WAPPI com sucesso");
        break;
    }
    // ========== ETAPA 5: PROCESSAR RESPOSTA DA API ==========
    if (isDebugMode) console.log("📊 [ETAPA 5] Processando resposta da API...");
    const responseData = await apiResponse.json();
    if (isDebugMode) {
      console.log("✅ [ETAPA 5] Resposta da API processada:");
      console.log(JSON.stringify(responseData, null, 2));
    }
    // ========== ETAPA 6: SALVAR NO BANCO (chatsZap) ==========
    if (isDebugMode) console.log("💾 [ETAPA 6] Salvando mensagem no banco de dados...");
    const dataToInsert = {
      chatId: chatId,
      instancia: instancia,
      empresa_id: empresa_id,
      mensagem: message,
      tsData: new Date().toISOString(),
      type: 'chat',
      enviado_pelo_operador: true
    };
    if (isDebugMode) {
      console.log("   - Dados a inserir:", {
        chatId: dataToInsert.chatId,
        instancia: dataToInsert.instancia,
        empresa_id: dataToInsert.empresa_id,
        type: dataToInsert.type,
        enviado_pelo_operador: dataToInsert.enviado_pelo_operador
      });
    }
    const { error: insertError } = await supabaseClient.from('chatsZap').insert(dataToInsert);
    if (insertError) {
      console.error("⚠️ [ETAPA 6] Erro ao salvar no chatsZap (não crítico):", insertError.message);
    // Não lança erro, pois a mensagem principal já foi enviada
    } else {
      if (isDebugMode) console.log("✅ [ETAPA 6] Mensagem salva no chatsZap com sucesso");
    }
    // ========== ETAPA 7: RETORNO FINAL ==========
    if (isDebugMode) console.log("🎉 [ETAPA 7] Processo concluído com sucesso!");
    return new Response(JSON.stringify({
      success: true,
      api_provider: api_provider,
      empresa: fantasia,
      detail: responseData
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    // ========== TRATAMENTO DE ERROS ==========
    console.error('🔥 [ERRO CRÍTICO] Erro na Edge Function send-whatsapp-message:', error);
    console.error('   - Mensagem:', error.message);
    console.error('   - Stack:', error.stack);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
