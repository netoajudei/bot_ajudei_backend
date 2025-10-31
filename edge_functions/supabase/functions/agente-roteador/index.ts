// Esta é a sua função principal. Ela atua como um "roteador" e, em seguida,
// como um "especialista", executando o ciclo completo de IA numa única função.
// VERSÃO ATUALIZADA: Agora usa o novo 'send-whatsapp-gateway' para todas as notificações.
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
    // 1. Recebe o ID da conversa.
    const { compelition_id } = await req.json();
    if (!compelition_id) throw new Error("O 'compelition_id' não foi fornecido.");
    if (isDebugMode) console.warn(`▶️ [AGENTE ROTEADOR] Iniciado para a conversa ID: ${compelition_id}`);
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Busca a conversa de PRODUÇÃO, os dados do cliente e a EMPRESA.
    const { data: compelition, error: compelitionError } = await supabaseClient.from('compelition').select('chat, cliente, empresa(id, em_teste, contato_respostas), clientes!inner(chatId, instancia)').eq('id', compelition_id).single();
    if (compelitionError) throw new Error(`Erro ao buscar a compelition: ${compelitionError.message}`);
    const empresa_id = compelition.empresa.id;
    if (isDebugMode) console.warn(`... Usando empresa_id dinâmico: ${empresa_id}`);
    // 3. Busca a chave da OpenAI para a empresa.
    const { data: apiKeyData, error: apiKeyError } = await supabaseClient.from('api_keys').select('openai_api_key').eq('empresa_id', empresa_id).single();
    if (apiKeyError || !apiKeyData?.openai_api_key) {
      throw new Error(`Chave de API da OpenAI não encontrada para a empresa ID: ${empresa_id}`);
    }
    const openAiApiKey = apiKeyData.openai_api_key;
    // 4. Busca o PROMPT DO ROTEADOR.
    const { data: routerPromptData, error: routerPromptError } = await supabaseClient.from('prompt').select('prompt, tools, modelo_ia').eq('empresa', empresa_id).eq('tipo_prompt', 'roteador').single();
    if (routerPromptError) throw new Error(`Nenhum prompt do tipo 'roteador' encontrado.`);
    if (isDebugMode) console.warn("... Prompt do roteador carregado.");
    // 5. PRIMEIRA CHAMADA À IA (ROTEAMENTO)
    let messages = [
      {
        role: 'system',
        content: routerPromptData.prompt
      },
      ...compelition.chat || []
    ];
    let openAiPayload = {
      model: routerPromptData.modelo_ia || "gpt-4o-mini",
      messages,
      tools: (routerPromptData.tools || []).map((t)=>({
          type: 'function',
          function: t
        })),
      tool_choice: "auto"
    };
    if (isDebugMode) console.warn("... Enviando chamada de ROTEAMENTO para a OpenAI...");
    let openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify(openAiPayload)
    });
    if (!openAiResponse.ok) throw new Error(`Erro na API da OpenAI (Roteamento): ${await openAiResponse.text()}`);
    let assistantResponse = (await openAiResponse.json()).choices[0].message;
    // 6. DECISÃO DO ROTEADOR
    if (assistantResponse.tool_calls) {
      const toolCall = assistantResponse.tool_calls[0];
      const nomeAgenteEspecialista = toolCall.function.name;
      if (isDebugMode) console.warn(`... Roteador decidiu acionar o agente: '${nomeAgenteEspecialista}'.`);
      try {
        await supabaseClient.from('agent_invocations').insert({
          empresa_id: empresa_id,
          nome_agente: nomeAgenteEspecialista,
          compelition_id: compelition_id,
          cliente_id: compelition.cliente
        });
        if (isDebugMode) console.warn(`... Métrica registada para o agente '${nomeAgenteEspecialista}'.`);
      } catch (metricError) {
        console.error("AVISO: Falha ao registar a métrica de invocação do agente:", metricError);
      }
      const { data: especialistaPromptData, error: especialistaPromptError } = await supabaseClient.from('prompt').select('prompt, tools, modelo_ia').eq('empresa', empresa_id).eq('nome_agente', nomeAgenteEspecialista).single();
      if (especialistaPromptError) throw new Error(`Configuração para o agente especialista '${nomeAgenteEspecialista}' não encontrada.`);
      // 7. SEGUNDA CHAMADA À IA (ESPECIALISTA)
      messages = [
        {
          role: 'system',
          content: especialistaPromptData.prompt
        },
        ...compelition.chat || []
      ];
      openAiPayload = {
        model: especialistaPromptData.modelo_ia || "gpt-4o-mini",
        messages,
        tools: (especialistaPromptData.tools || []).map((t)=>({
            type: 'function',
            function: t
          })),
        tool_choice: "auto"
      };
      if (isDebugMode) console.warn(`... Enviando chamada de ESPECIALISTA para a OpenAI...`);
      openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openAiApiKey}`
        },
        body: JSON.stringify(openAiPayload)
      });
      if (!openAiResponse.ok) throw new Error(`Erro na API da OpenAI (Especialista): ${await openAiResponse.text()}`);
      assistantResponse = (await openAiResponse.json()).choices[0].message;
    }
    // --- 7. ORQUESTRAÇÃO FINAL ---
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: compelition.cliente,
      p_new_message: assistantResponse
    });
    if (isDebugMode) console.warn("... Resposta final do especialista salva no histórico de PRODUÇÃO.");
    if (assistantResponse.tool_calls) {
      if (isDebugMode) console.warn("... Especialista decidiu usar uma ferramenta final.");
      for (const finalToolCall of assistantResponse.tool_calls){
        const { data: toolDefinition } = await supabaseClient.from('functions').select('edge_function_name').eq('empresa', empresa_id).eq('nome', finalToolCall.function.name).single();
        if (toolDefinition?.edge_function_name) {
          const functionToCall = toolDefinition.edge_function_name;
          const finalPayload = {
            args: JSON.parse(finalToolCall.function.arguments || '{}'),
            compelition_id,
            tool_call_id: finalToolCall.id,
            clientes_id: compelition.cliente,
            chatId: compelition.clientes.chatId,
            instancia: compelition.clientes.instancia
          };
          if (isDebugMode) console.warn(`🚀 Invocando a função final: '${functionToCall}'`);
          fetch(`${supabaseUrl}/functions/v1/${functionToCall}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify(finalPayload)
          }).catch(console.error);
        }
      }
    } else if (assistantResponse.content) {
      if (isDebugMode) console.warn("... Enviando resposta final de texto para o cliente.");
      const assistantMessageText = assistantResponse.content;
      const lastUserMessage = (compelition.chat || []).findLast((m)=>m.role === 'user')?.content || 'Não foi possível encontrar a última pergunta.';
      const messageForTeam = `📝 **[NOVO AGENTE]** 📝\n---\n**Cliente Perguntou:**\n_"${lastUserMessage}"_\n---\n**Agente Respondeu:**\n_"${assistantMessageText}"_`.trim();
      // *** ALTERAÇÃO APLICADA AQUI: Usa o novo gateway para a equipe ***
      if (compelition.empresa.contato_respostas && Array.isArray(compelition.empresa.contato_respostas)) {
        for (const contactId of compelition.empresa.contato_respostas){
          fetch(`${supabaseUrl}/functions/v1/feedback-gateway`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify({
              empresa_id: empresa_id,
              feedback_type: "contato_respostas",
              message: messageForTeam
            })
          }).catch(console.error);
        }
      }
      // *** ALTERAÇÃO APLICADA AQUI: Usa o novo gateway para o cliente ***
      if (compelition.empresa.em_teste === false) {
        fetch(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            cliente_id: compelition.cliente,
            message: assistantMessageText
          })
        }).catch(console.error);
      }
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Fluxo de agente executado."
    }));
  } catch (error) {
    console.error('🔥 Erro no Agente Roteador/Executor:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
