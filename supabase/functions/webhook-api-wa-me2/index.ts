// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// Define os cabeçalhos CORS
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
    // --- FILTRO DE GRUPOS ---
    if (data.isGroup) {
      if (isDebugMode) console.warn("👥 Mensagem de grupo ignorada.");
      return new Response('ok: group message ignored', {
        headers: corsHeaders
      });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- BUSCA DA EMPRESA PELA CHAVE DA API ---
    const { data: apiKeyData, error: apiKeyError } = await supabaseClient.from('api_keys').select('empresa_id, empresa(instanciaChat)').eq('wa_me_key', key).single();
    if (apiKeyError || !apiKeyData || !apiKeyData.empresa) {
      throw new Error(`Nenhuma empresa encontrada para a chave (key): ${key}`);
    }
    const empresa_id = apiKeyData.empresa_id;
    const instancia = apiKeyData.empresa.instanciaChat;
    // *** CORREÇÃO APLICADA AQUI ***
    // Usa o `remoteJid` para o cliente e adiciona o sufixo para manter o padrão.
    const chatId = data.remoteJid + '@c.us';
    // --- TRIAGEM DO TIPO DE MENSAGEM ---
    let pergunta_cliente = '';
    let hasAudio = false;
    let type = 'chat'; // Padrão
    switch(data.messageType){
      case 'conversation':
      case 'extendedTextMessage':
        pergunta_cliente = data.msgContent?.conversation || data.msgContent?.text || '';
        break;
      case 'audioMessage':
        pergunta_cliente = "audio"; // Texto padrão para IA
        hasAudio = true;
        type = 'ptt';
        break;
      case 'imageMessage':
      case 'videoMessage':
        {
          if (isDebugMode) console.warn(`🖼️ Mensagem de mídia (${data.messageType}) recebida. Respondendo diretamente ao cliente.`);
          const mediaType = data.messageType === 'imageMessage' ? 'imagens' : 'vídeos';
          const responseMessage = `Desculpe, ainda não consigo processar mídias como ${mediaType}. Por favor, envie sua pergunta em texto. 😊`;
          const apiUrl = `https://us.api-wa.me/${key}/message/text`;
          const payload = {
            to: data.remoteJid,
            text: responseMessage
          };
          fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          }).catch((err)=>console.error(`[AVISO] Falha ao enviar resposta automática para ${data.remoteJid}:`, err));
          return new Response('ok: media message handled directly', {
            headers: corsHeaders
          });
        }
      default:
        if (isDebugMode) console.warn(`⚠️ Tipo de mensagem não suportado '${data.messageType}' recebido. Ignorando.`);
        return new Response('ok: unsupported message type', {
          headers: corsHeaders
        });
    }
    if (!pergunta_cliente) {
      if (isDebugMode) console.warn("📖 Mensagem vazia ou sem conteúdo textual. Ignorando.");
      return new Response('ok: empty message', {
        headers: corsHeaders
      });
    }
    // --- AÇÃO FINAL: INSERIR NO CHATSZAP PARA ACIONAR O FLUXO DE PRODUÇÃO ---
    const timestampMs = (data.messageTimestamp.low || data.messageTimestamp) * 1000;
    const { error: insertError } = await supabaseClient.from('chatsZap').insert({
      instancia: instancia,
      chatId: chatId,
      tsData: new Date(timestampMs).toISOString(),
      mensagem: pergunta_cliente,
      type: type,
      temAudio: hasAudio,
      agregado: false,
      menuEstatico: false
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
