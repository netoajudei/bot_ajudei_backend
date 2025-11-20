// Esta função atua como um "agente especialista" para reservas.
// Ela é chamada pelo orquestrador principal e executa um ciclo de IA completo
// com um prompt e ferramentas focados apenas em reservas.
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
    // 1. Recebe o payload do orquestrador principal.
    const { compelition_id, tool_call_id, clientes_id, chatId, instancia, chat_history } = await req.json();
    if (!compelition_id) {
      throw new Error("Payload do orquestrador principal incompleto.");
    }
    if (isDebugMode) console.warn(`▶️ [AGENTE DE RESERVAS] Iniciado para a conversa ID: ${compelition_id}`);
    // 2. Inicializa os clientes e obtém os secrets.
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const openAiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!supabaseUrl || !serviceKey || !openAiApiKey) {
      throw new Error("Variáveis de ambiente essenciais não configuradas.");
    }
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 3. Busca a empresa.
    const { data: compelition, error: compelitionError } = await supabaseClient.from('compelition').select('empresa(id)').eq('id', compelition_id).single();
    if (compelitionError) throw new Error(`Erro ao buscar a empresa da compelition: ${compelitionError.message}`);
    // 4. Busca o prompt e as ferramentas ESPECIALIZADAS da tabela prompt_reserva.
    const { data: promptReservaData, error: promptError } = await supabaseClient.from('prompt_reserva').select('prompt_texto, tools').eq('empresa_id', compelition.empresa.id).single();
    if (promptError) throw new Error(`Nenhum prompt de reserva encontrado para a empresa ${compelition.empresa.id}.`);
    if (isDebugMode) console.warn("... Prompt especializado de reservas carregado.");
    // 5. Prepara e faz a SEGUNDA chamada à API da OpenAI.
    const systemPromptText = promptReservaData.prompt_texto;
    // Usa o histórico de chat recebido do orquestrador.
    const messages = [
      {
        role: 'system',
        content: systemPromptText
      },
      ...chat_history || []
    ];
    const openAITools = (promptReservaData.tools || []).map((t)=>({
        type: 'function',
        function: t
      }));
    const openAiPayload = {
      model: "gpt-4o-mini",
      messages,
      tools: openAITools.length > 0 ? openAITools : undefined,
      tool_choice: "auto",
      temperature: 0.1 // Temperatura mais baixa para mais precisão
    };
    if (isDebugMode) console.warn("... Enviando chamada para a OpenAI com o prompt especializado.");
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify(openAiPayload)
    });
    if (!openAiResponse.ok) {
      const errorBody = await openAiResponse.json();
      throw new Error(`Erro na API da OpenAI (chamada especializada): ${openAiResponse.status} - ${JSON.stringify(errorBody)}`);
    }
    const openAiResult = await openAiResponse.json();
    const assistantResponse = openAiResult.choices[0]?.message;
    // *** CORREÇÃO CRUCIAL APLICADA AQUI ***
    // Anexa a resposta do agente especializado ao histórico para manter a consistência.
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: assistantResponse
    });
    if (isDebugMode) console.warn("... Resposta do agente especializado salva no histórico.");
    // 6. Orquestra a resposta do agente especializado.
    if (assistantResponse?.tool_calls && assistantResponse.tool_calls.length > 0) {
      if (isDebugMode) console.warn("... Agente de reservas decidiu usar uma ferramenta final (create, edit, cancel).");
      for (const finalToolCall of assistantResponse.tool_calls){
        const functionName = finalToolCall.function.name;
        const finalArgs = JSON.parse(finalToolCall.function.arguments || '{}');
        const toolPayload = {
          args: finalArgs,
          compelition_id,
          tool_call_id: finalToolCall.id,
          clientes_id,
          chatId,
          instancia
        };
        if (isDebugMode) console.warn(`🚀 Invocando a função final: ${functionName}`);
        fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify(toolPayload)
        }).catch(console.error);
      }
    } else if (assistantResponse?.content) {
      if (isDebugMode) console.warn("... Agente de reservas decidiu responder com texto.");
      // Se o agente especializado responder com texto, envia-o para o utilizador.
      fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`
        },
        body: JSON.stringify({
          chatId,
          instancia,
          message: assistantResponse.content
        })
      }).catch(console.error);
    }
    return new Response(JSON.stringify({
      success: true
    }));
  } catch (error) {
    console.error('🔥 Erro na Edge Function acionar_fluxo_reserva:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
