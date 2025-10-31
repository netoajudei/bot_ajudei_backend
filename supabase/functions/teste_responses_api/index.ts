// Edge Function: teste_responses_api v2.4
// Correção: Lógica de gestão de estado (stateful) implementada corretamente.
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
    // --- 1. Recebe o chatsZap_id ---
    const { chatszap_id } = await req.json();
    if (!chatszap_id) throw new Error("O 'chatszap_id' não foi fornecido.");
    if (isDebugMode) console.log("📨 Processando chatsZap ID:", chatszap_id);
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 2. Busca a mensagem do chatsZap ---
    const { data: chatsZap, error: chatsZapError } = await supabaseClient.from('chatsZap').select('id, mensagem, chatId, instancia, empresa_id, clientes_id').eq('id', chatszap_id).single();
    if (chatsZapError || !chatsZap) {
      throw new Error(`Mensagem não encontrada: ${chatsZapError?.message}`);
    }
    // --- 3. Busca o cliente e o ESTADO ANTERIOR da conversa ---
    const { data: cliente, error: clienteError } = await supabaseClient.from('clientes').select('id, uuid_identificador, chatId, instancia, openai_last_response_id, empresa_id').eq('chatId', chatsZap.chatId).eq('empresa_id', chatsZap.empresa_id).single();
    if (clienteError || !cliente) {
      throw new Error(`Cliente não encontrado para chatId ${chatsZap.chatId} e empresa ${chatsZap.empresa_id}`);
    }
    const { id: cliente_id, empresa_id, uuid_identificador, openai_last_response_id } = cliente;
    // --- 4. Busca as configurações (Prompt e Chave de API) ---
    const { data: empresa } = await supabaseClient.from('empresa').select('id, em_teste, contato_respostas').eq('id', empresa_id).single();
    const { data: promptData } = await supabaseClient.from('prompt').select('prompt, tools, modelo_ia').eq('empresa', empresa_id).eq('tipo_prompt', 'principal').single();
    const { data: apiKeyData } = await supabaseClient.from('api_keys').select('openai_api_key').eq('empresa_id', empresa_id).single();
    if (!apiKeyData?.openai_api_key) {
      throw new Error(`Chave OpenAI não configurada para empresa ${empresa_id}`);
    }
    const linkReserva = `https://ajudei.app/reserva/${uuid_identificador}`;
    const systemPromptWithLink = `
      ${promptData.prompt}
      INSTRUÇÃO ADICIONAL: O link de reserva exclusivo para este cliente é: ${linkReserva}
    `.trim();
    // --- 5. PREPARAÇÃO DA CHAMADA PARA A NOVA API /responses ---
    let payload = {
      model: promptData.modelo_ia || "gpt-5-mini",
      instructions: systemPromptWithLink,
      input: chatsZap.mensagem,
      store: true
    };
    // *** LÓGICA DE ESTADO DA CONVERSA APLICADA AQUI ***
    if (openai_last_response_id) {
      payload.previous_response_id = openai_last_response_id;
      if (isDebugMode) console.warn(`🔄 [ESTADO] Continuidade da conversa. Usando ID da resposta anterior: ${openai_last_response_id}`);
    } else {
      if (isDebugMode) console.warn(`🆕 [ESTADO] Primeira mensagem detectada. Iniciando nova conversa.`);
    }
    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyData.openai_api_key}`
      },
      body: JSON.stringify(payload)
    });
    if (!openAiResponse.ok) {
      const errorBody = await openAiResponse.text();
      throw new Error(`OpenAI Error: ${errorBody}`);
    }
    const openAiResult = await openAiResponse.json();
    if (isDebugMode) console.warn("🔍 [DIAGNÓSTICO] Resposta completa da OpenAI recebida:", JSON.stringify(openAiResult, null, 2));
    let assistantText = "Desculpe, não consegui processar sua solicitação.";
    try {
      const outputMessage = openAiResult.output?.[0];
      if (outputMessage?.type === 'message' && outputMessage.role === 'assistant') {
        const textContent = outputMessage.content?.find((c)=>c.type === 'output_text');
        if (textContent?.text) {
          assistantText = textContent.text;
        }
      }
    } catch (e) {
      if (isDebugMode) console.error("❌ Erro ao tentar extrair o texto da resposta da OpenAI:", e);
    }
    // --- 6. ATUALIZAÇÃO DO ESTADO DA CONVERSA ---
    const new_response_id = openAiResult.id;
    const { error: updateError } = await supabaseClient.from('clientes').update({
      openai_last_response_id: new_response_id
    }).eq('id', cliente_id);
    if (updateError) {
      console.error("⚠️ [ESTADO] Erro ao atualizar o last_response_id:", updateError);
    } else {
      if (isDebugMode) console.warn(`✅ [ESTADO] Last response ID atualizado no cliente ${cliente_id} para: ${new_response_id}`);
    }
    // --- LÓGICA DE ENVIO SUSPENSA PARA TESTE ---
    if (isDebugMode) {
      console.warn("🚫 [MODO DE TESTE] O envio de mensagem para o cliente foi suspenso.");
      console.warn("💬 A resposta que seria enviada é:", `"${assistantText}"`);
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Processamento concluído"
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('🔥 Erro no Orquestrador v2:', error);
    return new Response(JSON.stringify({
      error: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
