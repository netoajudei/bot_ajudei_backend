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
    // --- 1. Inicialização e Validação ---
    const { compelition_id } = await req.json();
    if (!compelition_id) throw new Error("O 'compelition_id' não foi fornecido.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 2. Busca de Dados ---
    const { data: compelition, error: compelitionError } = await supabaseClient.from('compelition').select('chat, cliente, empresa(id, em_teste, contato_respostas), clientes!inner(id, uuid_identificador, chatId, empresa_id, instancia)').eq('id', compelition_id).single();
    if (compelitionError) throw new Error(`Erro ao buscar a compelition: ${compelitionError.message}`);
    const { data: promptData, error: promptError } = await supabaseClient.from('prompt').select('prompt, tools, modelo_ia').eq('empresa', compelition.empresa.id).eq('tipo_prompt', 'principal').single();
    if (promptError) throw new Error(`Nenhum prompt do tipo 'principal' encontrado para esta empresa.`);
    const { data: apiKeyData, error: apiKeyError } = await supabaseClient.from('api_keys').select('openai_api_key').eq('empresa_id', compelition.empresa.id).single();
    if (apiKeyError || !apiKeyData?.openai_api_key) {
      throw new Error(`Chave de API da OpenAI não encontrada para a empresa ID: ${compelition.empresa.id}`);
    }
    const openAiApiKey = apiKeyData.openai_api_key;
    // --- 3. GERAÇÃO DO LINK DINÂMICO ---
    const cliente_uuid = compelition.clientes.uuid_identificador;
    const linkReserva = `https://www.ajudei.app/reserva/${cliente_uuid}`; // URL atualizado
    if (isDebugMode) console.warn("... Link de reserva dinâmico gerado:", linkReserva);
    // --- 4. PREPARAÇÃO DA CHAMADA PARA OPENAI COM A VARIÁVEL ---
    const dataAtual = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    });
    const systemPromptText = `
      <data>${dataAtual}</data>
      ${promptData.prompt}
      
      INSTRUÇÃO ADICIONAL: O link de reserva exclusivo para este cliente é: ${linkReserva}. Você deve fornecê-lo apenas se o cliente perguntar sobre como fazer, alterar ou cancelar uma reserva.
    `.trim();
    const messages = [
      {
        role: 'system',
        content: systemPromptText
      },
      ...compelition.chat || []
    ];
    const openAiPayload = {
      model: promptData.modelo_ia || "gpt-4.1-mini",
      messages,
      tools: (promptData.tools || []).map((t)=>({
          type: 'function',
          function: t
        })),
      tool_choice: "auto"
    };
    // --- 5. Execução e Orquestração Final ---
    if (isDebugMode) console.warn("... Enviando chamada para a OpenAI com o prompt enriquecido...");
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify(openAiPayload)
    });
    if (!openAiResponse.ok) {
      const errorBody = await openAiResponse.text();
      throw new Error(`Erro na API da OpenAI: ${openAiResponse.status} - ${errorBody}`);
    }
    const openAiResult = await openAiResponse.json();
    const assistantResponse = openAiResult.choices[0].message;
    if (isDebugMode) console.warn("... Resposta da OpenAI recebida com sucesso.");
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: compelition.cliente,
      p_new_message: assistantResponse
    });
    // *** LÓGICA DE TOOL CALLS ATUALIZADA AQUI ***
    if (assistantResponse.tool_calls) {
      if (isDebugMode) console.warn("... IA decidiu usar uma ferramenta.");
      for (const toolCall of assistantResponse.tool_calls){
        const functionNameFromAI = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let functionToCall = '';
        // Roteador de Ferramentas
        switch(functionNameFromAI){
          case 'vagasDeEmprego':
            functionToCall = 'recrutamento';
            break;
          case 'parceirosFornecedores':
            functionToCall = 'novos-parceiros';
            break;
          default:
            // Para qualquer outra ferramenta, assume que o nome corresponde
            functionToCall = functionNameFromAI;
            break;
        }
        const payload = {
          args: args,
          compelition_id: compelition_id,
          tool_call_id: toolCall.id,
          clientes_id: compelition.cliente,
          chatId: compelition.clientes.chatId,
          instancia: compelition.clientes.instancia
        };
        if (functionToCall) {
          if (isDebugMode) {
            console.warn(`🚀 Invocando a função final: '${functionToCall}'`);
            console.log("Payload enviado:", JSON.stringify(payload, null, 2));
          }
          // Aciona a Edge Function final
          fetch(`${supabaseUrl}/functions/v1/${functionToCall}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify(payload)
          }).catch(console.error);
        }
      }
    } else if (assistantResponse.content) {
      const assistantMessageText = assistantResponse.content;
      const lastUserMessage = (compelition.chat || []).findLast((m)=>m.role === 'user')?.content || 'Não foi possível encontrar a última pergunta.';
      const messageForTeam = `📝 **[Link Dinâmico]** 📝\n---\n**Cliente Perguntou:**\n_"${lastUserMessage}"_\n---\n**IA Respondeu:**\n_"${assistantMessageText}"_`.trim();
      if (compelition.empresa.contato_respostas && Array.isArray(compelition.empresa.contato_respostas)) {
        for (const contactId of compelition.empresa.contato_respostas){
          fetch(`${supabaseUrl}/functions/v1/feedback-gateway`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify({
              empresa_id: compelition.empresa.id,
              feedback_type: 'contato_respostas',
              message: messageForTeam
            })
          }).catch(console.error);
        }
      }
      // Notificação para o cliente
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
      message: "Processamento concluído."
    }));
  } catch (error) {
    console.error('🔥 Erro no Orquestrador com Link Dinâmico:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
