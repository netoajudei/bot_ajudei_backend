// supabase/functions/webhook-api-wa-me3/index.ts
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
    if (isDebugMode) console.warn("▶️ [Webhook API-WA.ME v3] Payload:", JSON.stringify(body, null, 2));
    const { instance: key, data } = body;
    if (!key || !data) throw new Error("Payload inválido.");
    // Ignora grupos
    if (data.isGroup) {
      if (isDebugMode) console.warn("👥 Grupo ignorado.");
      return new Response('ok: group ignored', {
        headers: corsHeaders
      });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // *** ALTERAÇÃO APLICADA AQUI ***
    // Busca empresa pela chave E já traz a instanciaChat numérica
    const { data: apiKeyData, error: apiKeyError } = await supabaseClient.from('api_keys').select('empresa_id, empresa!inner(instanciaChat)').eq('wa_me_key', key).single();
    if (apiKeyError || !apiKeyData?.empresa) {
      throw new Error(`Empresa não encontrada para key: ${key}`);
    }
    const empresa_id = apiKeyData.empresa_id;
    const instancia = apiKeyData.empresa.instanciaChat; // Este é o valor numérico (ex: 80432)
    if (isDebugMode) console.warn(`🏢 Empresa ID: ${empresa_id}, Instancia: ${instancia}`);
    // *** BIFURCAÇÃO PRINCIPAL: isLid ***
    const isLid = data.isLid === true;
    let chatId;
    if (isLid) {
      // Usa o remoteJid com sufixo @lid
      chatId = data.remoteJid + '@lid';
      if (isDebugMode) console.warn(`🔐 Mensagem LID detectada. chatId: ${chatId}`);
    } else {
      // Fluxo normal: @c.us
      chatId = data.remoteJid;
      if (isDebugMode) console.warn(`📱 Mensagem normal. chatId: ${chatId}`);
    }
    // Extração do conteúdo
    let pergunta_cliente = '';
    let hasAudio = false;
    let type = 'chat';
    switch(data.messageType){
      case 'conversation':
        pergunta_cliente = data.msgContent?.conversation || '';
        break;
      case 'extendedTextMessage':
        pergunta_cliente = data.msgContent?.extendedTextMessage?.text || '';
        break;
      case 'audioMessage':
        pergunta_cliente = "audio";
        hasAudio = true;
        type = 'ptt';
        break;
      case 'imageMessage':
      case 'videoMessage':
        // Resposta automática para mídia
        const mediaType = data.messageType === 'imageMessage' ? 'imagens' : 'vídeos';
        const responseMsg = `Desculpe, ainda não consigo processar ${mediaType}. Por favor, envie sua pergunta em texto. 😊`;
        fetch(`https://us.api-wa.me/${key}/message/text`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            to: data.remoteJid,
            text: responseMsg
          })
        }).catch((err)=>console.error(`Erro ao enviar resposta de mídia:`, err));
        return new Response('ok: media handled', {
          headers: corsHeaders
        });
      default:
        if (isDebugMode) console.warn(`⚠️ Tipo não suportado: ${data.messageType}`);
        return new Response('ok: unsupported type', {
          headers: corsHeaders
        });
    }
    // *** TRATAMENTO ESPECIAL PARA @lid SEM CONTEÚDO ***
    if (isLid && (!pergunta_cliente || pergunta_cliente.trim() === '')) {
      if (isDebugMode) console.warn("📭 Mensagem LID vazia/criptografada. Enviando fallback.");
      // Verifica se cliente já existe
      const { data: clienteExiste } = await supabaseClient.from('clientes').select('id').eq('chatId', chatId).eq('empresa_id', empresa_id).single();
      if (!clienteExiste) {
        // Cliente novo + mensagem vazia = solicitar reenvio
        const fallbackMsg = "Olá! Não consegui processar sua mensagem. Poderia repetir sua pergunta? 😊";
        fetch(`https://us.api-wa.me/${key}/message/text`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            to: data.remoteJid,
            text: fallbackMsg
          })
        }).catch((err)=>console.error(`Erro ao enviar fallback:`, err));
        if (isDebugMode) console.warn("✅ Fallback enviado para novo cliente LID.");
      }
      return new Response('ok: lid empty message', {
        headers: corsHeaders
      });
    }
    // Validação final de conteúdo
    if (!pergunta_cliente || pergunta_cliente.trim() === '') {
      if (isDebugMode) console.warn("📖 Mensagem vazia. Ignorando.");
      return new Response('ok: empty message', {
        headers: corsHeaders
      });
    }
    // Inserir no chatsZap
    const timestampMs = (data.messageTimestamp?.low || data.messageTimestamp) * 1000;
    const { error: insertError } = await supabaseClient.from('chatsZap').insert({
      instancia: instancia,
      chatId: chatId,
      tsData: new Date(timestampMs).toISOString(),
      mensagem: pergunta_cliente,
      notfyName: data.pushName || '',
      type: type,
      temAudio: hasAudio,
      agregado: false,
      menuEstatico: false,
      empresa_id: empresa_id
    });
    if (insertError) throw new Error(`Erro ao inserir em chatsZap: ${insertError.message}`);
    if (isDebugMode) console.warn(`✅ Mensagem inserida. chatId: ${chatId}, instancia: ${instancia}`);
    return new Response(JSON.stringify({
      success: true
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('🔥 Erro no Webhook v3:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
