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
    const openAiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!supabaseUrl || !serviceKey || !openAiApiKey) {
      throw new Error("Variáveis de ambiente essenciais (URL, SERVICE_KEY, OPENAI_KEY) não configuradas nos secrets desta Edge Function.");
    }
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 2. Busca de Dados ---
    const { data: compelition, error: compelitionError } = await supabaseClient.from('compelition').select('chat, cliente, empresa(id, em_teste, contato_respostas, contato_vagas_de_emprego), clientes!inner(chatId, instancia)').eq('id', compelition_id).single();
    if (compelitionError) throw new Error(`Erro ao buscar a compelition com ID ${compelition_id}: ${compelitionError.message}`);
    const { data: promptData, error: promptError } = await supabaseClient.from('prompt').select('prompt, tools').eq('empresa', compelition.empresa.id).order('created_at', {
      ascending: false
    }).limit(1).single();
    if (promptError) throw new Error(`Nenhum prompt ativo encontrado para a empresa ${compelition.empresa.id}: ${promptError.message}`);
    // --- 3. Preparação da Chamada para OpenAI ---
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
      temperature: 1.0
    };
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
    if (isDebugMode) console.log("Resposta completa da API OpenAI:", JSON.stringify(openAiResult, null, 2));
    const assistantResponse = openAiResult.choices[0]?.message;
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: compelition.cliente,
      p_new_message: assistantResponse
    });
    // --- 4. Orquestração da Resposta ---
    if (assistantResponse?.tool_calls && assistantResponse.tool_calls.length > 0) {
      if (isDebugMode) console.log("Decisão da IA: Usar uma ou mais ferramentas.");
      for (const toolCall of assistantResponse.tool_calls){
        const functionNameFromAI = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let functionNameToCall = '';
        let toolPayload = {};
        if (isDebugMode) console.log(`Analisando a chamada da ferramenta: ${functionNameFromAI}`);
        // Roteador de Ferramentas
        switch(functionNameFromAI){
          case 'reservaDoVaranda':
            if (args.editar === true) {
              functionNameToCall = 'edit-reserva';
            } else if (args.cancelar === true) {
              functionNameToCall = 'cancel-reservation-client';
            } else {
              functionNameToCall = 'create-reserva';
            }
            break;
          case 'cardapio':
            functionNameToCall = 'execute-cardapio-tool';
            break;
          case 'vagasDeEmprego':
            functionNameToCall = 'recrutamento';
            if (isDebugMode) console.log("Decisão da Lógica: Chamar a função 'recrutamento'.");
            break;
          default:
            functionNameToCall = functionNameFromAI;
            break;
        }
        // Construtor de Payload
        if (functionNameToCall === 'create-reserva') {
          let formattedDate = args.data;
          if (args.data && args.data.includes('/') && args.data.split('/').length === 2) {
            const [day, month] = args.data.split('/');
            const now = new Date();
            let year = now.getFullYear();
            const currentMonth = now.getMonth() + 1;
            if (parseInt(month) < currentMonth) {
              year += 1;
            }
            formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          }
          toolPayload = {
            ...args,
            data: formattedDate,
            nome: args.identificacao,
            observacoes: args.preferencia,
            compelition_id: compelition_id,
            tool_call_id: toolCall.id,
            clientes_id: compelition.cliente,
            chatId: compelition.clientes.chatId,
            instancia: compelition.clientes.instancia
          };
        } else {
          toolPayload = {
            args: args,
            compelition_id: compelition_id,
            tool_call_id: toolCall.id,
            clientes_id: compelition.cliente,
            chatId: compelition.clientes.chatId,
            instancia: compelition.clientes.instancia
          };
        }
        if (functionNameToCall) {
          if (isDebugMode) {
            console.log(`Invocando a Edge Function: ${functionNameToCall}`);
            console.log("Payload enviado:", JSON.stringify(toolPayload, null, 2));
          }
          fetch(`${supabaseUrl}/functions/v1/${functionNameToCall}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`
            },
            body: JSON.stringify(toolPayload)
          }).catch(console.error);
        } else {
          if (isDebugMode) console.error("Não foi possível determinar qual função de ferramenta chamar.");
        }
      }
    } else if (assistantResponse?.content) {
      // Lógica de feedback mantida
      const assistantMessageText = assistantResponse.content;
      const lastUserMessage = compelition.chat.findLast((m)=>m.role === 'user')?.content || 'Não foi possível encontrar a última pergunta.';
      const messageForTeam = `📝 **NOVO FEEDBACK DE IA** 📝\n---\n**Cliente Perguntou:**\n_"${lastUserMessage}"_\n---\n**IA Respondeu:**\n_"${assistantMessageText}"_`.trim();
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
              empresa_id: compelition.empresa.id,
              feedback_type: "contato_respostas",
              message: messageForTeam
            })
          }).catch(console.error);
        }
      }
      // *** ALTERAÇÃO APLICADA AQUI: Usa o novo gateway para o cliente ***
      if (compelition.empresa.em_teste === false) {
        if (isDebugMode) console.log("Modo de produção. Enviando resposta para o cliente.");
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
      } else {
        if (isDebugMode) console.log("Modo de teste ativo. A resposta NÃO foi enviada para o cliente final.");
      }
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Processamento e feedback iniciados."
    }));
  } catch (error) {
    console.error('Erro na Edge Function orquestradora:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
