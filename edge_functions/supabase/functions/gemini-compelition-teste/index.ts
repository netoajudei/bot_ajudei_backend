// Importa os módulos necessários
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
    const { compelition_id } = await req.json();
    if (!compelition_id) throw new Error("O 'compelition_id' não foi fornecido.");
    if (isDebugMode) console.warn(`▶️ [1/4] Orquestrador iniciado para a conversa ID: ${compelition_id}`);
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const openAiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!supabaseUrl || !serviceKey || !openAiApiKey) {
      throw new Error("Variáveis de ambiente essenciais não configuradas.");
    }
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    const { data: compelition, error: compelitionError } = await supabaseClient.from('compelition').select('chat, cliente, empresa(id, em_teste, contato_respostas), clientes!inner(chatId, instancia)').eq('id', compelition_id).single();
    if (compelitionError) throw new Error(`Erro ao buscar a compelition com ID ${compelition_id}: ${compelitionError.message}`);
    const { data: promptData, error: promptError } = await supabaseClient.from('prompt').select('prompt, tools').eq('empresa', compelition.empresa.id).order('created_at', {
      ascending: false
    }).limit(1).single();
    if (promptError) throw new Error(`Nenhum prompt ativo encontrado para a empresa ${compelition.empresa.id}: ${promptError.message}`);
    if (isDebugMode) console.warn("▶️ [2/4] Dados da conversa e prompt principal carregados.");
    const dataAtual = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    });
    const systemPromptText = `<data>${dataAtual}</data>\n${promptData.prompt}`;
    const messages = [
      {
        role: 'system',
        content: systemPromptText
      },
      ...compelition.chat || []
    ];
    const openAITools = (promptData.tools || []).map((t)=>({
        type: 'function',
        function: t
      }));
    const openAiPayload = {
      model: "gpt-4o-mini",
      messages,
      tools: openAITools.length > 0 ? openAITools : undefined,
      tool_choice: "auto",
      temperature: 0.2
    };
    if (isDebugMode) console.warn("▶️ [3/4] Enviando chamada para a OpenAI...");
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
      throw new Error(`Erro na API da OpenAI: ${openAiResponse.status} - ${JSON.stringify(errorBody)}`);
    }
    const openAiResult = await openAiResponse.json();
    const assistantResponse = openAiResult.choices[0]?.message;
    // --- 4. Orquestração da Resposta ---
    if (assistantResponse?.tool_calls && assistantResponse.tool_calls.length > 0) {
      if (isDebugMode) console.warn("▶️ [4/4] Decisão da IA: Usar uma ferramenta.");
      const primaryToolCall = assistantResponse.tool_calls[0];
      const functionNameFromAI = primaryToolCall.function.name;
      // Se a intenção é uma reserva, delega para o agente especialista e ENCERRA.
      if (functionNameFromAI === 'aciona_fluxo_reserva') {
        if (isDebugMode) console.warn("... Roteando para o agente especialista de reservas e encerrando o orquestrador principal.");
        const toolPayload = {
          compelition_id: compelition_id,
          tool_call_id: primaryToolCall.id,
          clientes_id: compelition.cliente,
          chatId: compelition.clientes.chatId,
          instancia: compelition.clientes.instancia,
          // Passamos o histórico de chat ATUAL para o especialista.
          chat_history: compelition.chat || []
        };
        // Dispara a função especialista e não espera pela resposta.
        fetch(`${supabaseUrl}/functions/v1/acionar_fluxo_reserva`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify(toolPayload)
        }).catch(console.error);
      } else {
        // Para todas as outras ferramentas, o fluxo continua como antes.
        if (isDebugMode) console.warn("... Roteando para uma ferramenta padrão.");
        // Primeiro, grava a resposta da IA no histórico.
        await supabaseClient.rpc('append_to_compelition_chat', {
          p_cliente_id: compelition.cliente,
          p_new_message: assistantResponse
        });
        for (const toolCall of assistantResponse.tool_calls){
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const toolPayload = {
            args,
            compelition_id,
            tool_call_id: toolCall.id,
            clientes_id: compelition.cliente,
            chatId: compelition.clientes.chatId,
            instancia: compelition.clientes.instancia
          };
          fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify(toolPayload)
          }).catch(console.error);
        }
      }
    } else {
      // *** LÓGICA RESTAURADA ***
      // Se não for uma chamada de ferramenta, assume que é uma resposta de texto.
      if (isDebugMode) console.warn("▶️ [4/4] Decisão da IA: Responder com texto.");
      // Grava a resposta de texto no histórico.
      await supabaseClient.rpc('append_to_compelition_chat', {
        p_cliente_id: compelition.cliente,
        p_new_message: assistantResponse
      });
      const assistantMessageText = assistantResponse.content || "Desculpe, não entendi. Pode reformular a sua pergunta?";
      const lastUserMessage = compelition.chat.findLast((m)=>m.role === 'user')?.content || 'Não foi possível encontrar a última pergunta.';
      const messageForTeam = `📝 **NOVO FEEDBACK DE IA** 📝\n---\n**Cliente Perguntou:**\n_"${lastUserMessage}"_\n---\n**IA Respondeu:**\n_"${assistantMessageText}"_`.trim();
      if (compelition.empresa.contato_respostas && Array.isArray(compelition.empresa.contato_respostas)) {
        for (const contactId of compelition.empresa.contato_respostas){
          fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify({
              chatId: contactId,
              instancia: compelition.clientes.instancia,
              message: messageForTeam
            })
          }).catch(console.error);
        }
      }
      if (compelition.empresa.em_teste === false) {
        if (isDebugMode) console.warn("... Modo de produção. Enviando resposta para o cliente.");
        fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            chatId: compelition.clientes.chatId,
            instancia: compelition.clientes.instancia,
            message: assistantMessageText
          })
        }).catch(console.error);
      } else {
        if (isDebugMode) console.warn("... Modo de teste ativo. A resposta NÃO foi enviada para o cliente final.");
      }
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Processamento do orquestrador concluído."
    }));
  } catch (error) {
    console.error('🔥 Erro na Edge Function orquestradora:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
