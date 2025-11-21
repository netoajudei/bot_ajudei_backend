// Este webhook foi atualizado para lidar com os diferentes formatos de timestamp
// enviados pela API, tornando a função mais robusta.
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
    const body = await req.json();
    if (isDebugMode) console.warn("▶️ [Webhook API-WA.ME] Payload recebido:", JSON.stringify(body, null, 2));
    const { instance: key, data } = body;
    if (!key || !data) {
      throw new Error("Payload inválido. 'instance' (key) ou 'data' não encontrados.");
    }
    if (data.isGroup) {
      if (isDebugMode) console.warn("👥 Mensagem de grupo ignorada.");
      return new Response('ok: group message ignored', {
        headers: corsHeaders
      });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    const { data: apiKeyData, error: apiKeyError } = await supabaseClient.from('api_keys').select('empresa_id, empresa(instanciaChat)').eq('wa_me_key', key).single();
    if (apiKeyError || !apiKeyData) {
      throw new Error(`Nenhuma empresa encontrada para a chave (key): ${key}`);
    }
    const empresa_id = apiKeyData.empresa_id;
    const instancia = apiKeyData.empresa.instanciaChat;
    // Usa o key.remoteJid como a fonte mais confiável, removendo sufixos.
    const chatIdDoCliente = data.key.remoteJid.split('@')[0];
    if (isDebugMode) console.warn(`... Empresa ID: ${empresa_id}, Instancia: ${instancia}, ChatID: ${chatIdDoCliente}`);
    let pergunta_cliente = '';
    let tipo_mensagem = 'text';
    switch(data.messageType){
      case 'conversation':
      case 'extendedTextMessage':
        // CORREÇÃO APLICADA: Agora busca o texto corretamente para extendedTextMessage
        pergunta_cliente = data.msgContent?.conversation || data.msgContent?.extendedTextMessage?.text || '';
        tipo_mensagem = 'chat';
        break;
      case 'imageMessage':
      case 'videoMessage':
        const mediaType = data.messageType === 'imageMessage' ? 'imagem' : 'vídeo';
        if (isDebugMode) console.warn(`🖼️ Mensagem de ${mediaType} recebida. Respondendo ao cliente e encerrando o fluxo.`);
        try {
          const response = await fetch(`${supabaseUrl}/functions/v1/send_whats_wame`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify({
              key: key,
              chatId: chatIdDoCliente,
              message: `Desculpe, ainda não consigo processar mídias como ${mediaType}s. Por favor, envie sua pergunta em texto. 😊`
            })
          });
          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`A chamada para 'send_whats_wame' falhou com status ${response.status}. Resposta: ${errorBody}`);
          }
        } catch (notificationError) {
          if (isDebugMode) console.error("❌ Erro ao chamar a função de notificação:", notificationError);
        }
        return new Response('ok: media message handled', {
          headers: corsHeaders
        });
      case 'audioMessage':
        pergunta_cliente = "audio";
        tipo_mensagem = 'ptt';
        break;
      default:
        if (isDebugMode) console.warn(`⚠️ Tipo de mensagem não suportado '${data.messageType}' recebido. Ignorando.`);
        return new Response('ok: unsupported message type', {
          headers: corsHeaders
        });
    }
    // NOVA FUNCIONALIDADE: Notificar admin quando mensagem vazia for detectada
    if (!pergunta_cliente) {
      if (isDebugMode) console.warn("📖 Mensagem vazia ou sem conteúdo textual detectada. Notificando administrador...");
      // Envia notificação para o número do administrador
      try {
        const notificationResponse = await fetch(`${supabaseUrl}/functions/v1/send_whats_wame`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            key: key,
            chatId: '554898519922',
            message: `⚠️ ALERTA: Mensagem vazia detectada!\n\n` + `📱 Cliente: ${chatIdDoCliente}\n` + `🔑 Instância: ${instancia}\n` + `📝 Tipo: ${data.messageType}\n` + `⏰ Timestamp: ${new Date().toLocaleString('pt-BR')}\n\n` + `Payload completo:\n${JSON.stringify(data, null, 2)}`
          })
        });
        if (!notificationResponse.ok) {
          const errorBody = await notificationResponse.text();
          if (isDebugMode) console.error(`❌ Falha ao notificar admin: ${errorBody}`);
        } else {
          if (isDebugMode) console.warn("✅ Administrador notificado com sucesso.");
        }
      } catch (notificationError) {
        if (isDebugMode) console.error("❌ Erro ao notificar administrador:", notificationError);
      }
      return new Response('ok: empty message - admin notified', {
        headers: corsHeaders
      });
    }
    // --- CORREÇÃO DE TIMESTAMP ---
    // Lógica robusta para lidar com os dois formatos de timestamp.
    const timestampValue = typeof data.messageTimestamp === 'object' ? data.messageTimestamp.low : data.messageTimestamp;
    if (!timestampValue) {
      throw new Error("Timestamp da mensagem inválido ou não encontrado no payload.");
    }
    const tsDataFormatted = new Date(timestampValue * 1000).toISOString();
    // --- AÇÃO FINAL: INSERIR NO CHATSZAP COM A EMPRESA_ID ---
    const { error: insertError } = await supabaseClient.from('chatsZap').insert({
      instancia: instancia,
      chatId: chatIdDoCliente + '@c.us',
      tsData: tsDataFormatted,
      mensagem: pergunta_cliente,
      type: tipo_mensagem,
      empresa_id: empresa_id
    });
    if (insertError) {
      throw new Error(`Erro ao inserir registro em chatsZap: ${insertError.message}`);
    }
    if (isDebugMode) console.warn("✅ Mensagem inserida no chatsZap com sucesso. O fluxo de produção será acionado.");
    return new Response(JSON.stringify({
      success: true,
      message: "Mensagem recebida e enfileirada para processamento."
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('🔥 Erro no Webhook API-WA.ME:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
