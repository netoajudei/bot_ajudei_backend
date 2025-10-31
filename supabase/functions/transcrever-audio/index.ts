// Edge Function: transcrever-audio
// Baixa áudio do WhatsApp e transcreve usando Whisper da OpenAI
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
  try {
    const { audio_id, phone_number_id, empresa_id, chatId, notfyName, timestamp } = await req.json();
    console.warn(`🎤 [Transcrever] Iniciando transcrição`);
    console.warn(`   audio_id: ${audio_id}`);
    console.warn(`   phone_number_id: ${phone_number_id}`);
    console.warn(`   empresa_id: ${empresa_id}`);
    console.warn(`   chatId: ${chatId}`);
    if (!audio_id || !phone_number_id || !empresa_id || !chatId) {
      throw new Error('Parâmetros incompletos: audio_id, phone_number_id, empresa_id e chatId são obrigatórios');
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 1. Busca tokens (WhatsApp e OpenAI)
    console.warn(`🔑 [Transcrever] Buscando credenciais...`);
    const { data: apiKeys, error: apiKeysError } = await supabaseClient.from('api_keys').select('whatsapp_access_token, openai_api_key').eq('empresa_id', empresa_id).single();
    if (apiKeysError || !apiKeys) {
      throw new Error(`Erro ao buscar credenciais: ${apiKeysError?.message}`);
    }
    if (!apiKeys.whatsapp_access_token || !apiKeys.openai_api_key) {
      throw new Error('Credenciais incompletas na tabela api_keys');
    }
    const whatsappToken = apiKeys.whatsapp_access_token;
    const openaiKey = apiKeys.openai_api_key;
    // 2. Busca URL do áudio no WhatsApp
    console.warn(`📥 [Transcrever] Buscando URL do áudio no WhatsApp...`);
    const mediaUrl = `https://graph.facebook.com/v21.0/${audio_id}`;
    const mediaResponse = await fetch(mediaUrl, {
      headers: {
        'Authorization': `Bearer ${whatsappToken}`
      }
    });
    if (!mediaResponse.ok) {
      throw new Error(`Erro ao buscar mídia: ${mediaResponse.status} - ${await mediaResponse.text()}`);
    }
    const mediaData = await mediaResponse.json();
    const audioUrl = mediaData.url;
    console.warn(`✅ [Transcrever] URL do áudio obtida: ${audioUrl.substring(0, 50)}...`);
    // 3. Baixa o áudio
    console.warn(`⬇️ [Transcrever] Baixando áudio...`);
    const audioResponse = await fetch(audioUrl, {
      headers: {
        'Authorization': `Bearer ${whatsappToken}`
      }
    });
    if (!audioResponse.ok) {
      throw new Error(`Erro ao baixar áudio: ${audioResponse.status}`);
    }
    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBlob = new Blob([
      audioBuffer
    ], {
      type: 'audio/ogg'
    });
    console.warn(`✅ [Transcrever] Áudio baixado (${audioBuffer.byteLength} bytes)`);
    // 4. Transcreve com Whisper
    console.warn(`🤖 [Transcrever] Enviando para Whisper API...`);
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.ogg');
    formData.append('model', 'whisper-1');
    formData.append('language', 'pt');
    const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`
      },
      body: formData
    });
    if (!transcriptionResponse.ok) {
      const errorText = await transcriptionResponse.text();
      throw new Error(`Erro na transcrição: ${transcriptionResponse.status} - ${errorText}`);
    }
    const transcriptionData = await transcriptionResponse.json();
    const textoTranscrito = transcriptionData.text;
    console.warn(`✅ [Transcrever] Transcrição concluída!`);
    console.warn(`   Texto: "${textoTranscrito}"`);
    // 5. Busca o clientes_id (precisa para criar chatsZap completo)
    console.warn(`🔍 [Transcrever] Buscando cliente...`);
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('id').eq('chatId', chatId).eq('empresa_id', empresa_id).single();
    const clientes_id = clienteData?.id || null;
    if (clienteError || !clientes_id) {
      console.warn(`⚠️ [Transcrever] Cliente não encontrado - será criado pelo trigger`);
    } else {
      console.warn(`✅ [Transcrever] Cliente encontrado - ID: ${clientes_id}`);
    }
    // 6. CRIA o chatsZap com o texto transcrito
    console.warn(`💾 [Transcrever] Criando chatsZap com texto transcrito...`);
    const timestampMs = parseInt(timestamp) * 1000;
    const tsData = new Date(timestampMs).toISOString();
    const { data: insertData, error: insertError } = await supabaseClient.from('chatsZap').insert({
      instancia: phone_number_id,
      chatId: chatId,
      tsData: tsData,
      mensagem: textoTranscrito,
      type: 'ptt',
      temAudio: true,
      agregado: false,
      menuEstatico: false,
      notfyName: notfyName || '',
      empresa_id: empresa_id,
      clientes_id: clientes_id
    }).select();
    if (insertError) {
      throw new Error(`Erro ao criar chatsZap: ${insertError.message}`);
    }
    const chatszap_id = insertData?.[0]?.id;
    console.warn(`✅ [Transcrever] chatsZap criado com sucesso! ID: ${chatszap_id}`);
    console.warn(`🎯 [Transcrever] Trigger vai processar automaticamente em 20 segundos`);
    return new Response(JSON.stringify({
      success: true,
      transcricao: textoTranscrito,
      audio_id: audio_id,
      chatszap_id: chatszap_id
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('🔥 [Transcrever] Erro:', error);
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
