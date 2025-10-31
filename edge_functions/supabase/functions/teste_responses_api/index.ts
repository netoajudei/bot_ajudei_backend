// Esta é a sua nova função de orquestrador, desenhada para usar a API de "Respostas"
// stateful da OpenAI e para injetar a variável de link de reserva dinâmico.
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
    // --- 1. NOVO PONTO DE PARTIDA: Recebe o ID do chatsZap ---
    const { chatszap_id } = await req.json();
    if (!chatszap_id) throw new Error("O 'chatszap_id' não foi fornecido.");
    if (isDebugMode) console.warn(`▶️ [ORQUESTRADOR STATEFUL] Iniciado para o chatsZap ID: ${chatszap_id}`);
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 2. Busca a mensagem e o cliente a partir do chatsZap ---
    const { data: chatZapData, error: chatZapError } = await supabaseClient.from('chatsZap').select('mensagem, chatId, instancia').eq('id', chatszap_id).single();
    if (chatZapError) throw new Error(`Erro ao buscar o registro em chatsZap: ${chatZapError.message}`);
    const { mensagem, chatId, instancia } = chatZapData;
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('id, empresa_id, uuid_identificador, openai_last_response_id').eq('chatId', chatId)// Adicionar aqui um filtro pela empresa, se necessário
    .single();
    if (clienteError) throw new Error(`Erro ao buscar o cliente: ${clienteError.message}`);
    const { id: cliente_id, empresa_id, uuid_identificador, openai_last_response_id } = clienteData;
    // --- 3. Busca as configurações (Prompt e Chave de API) ---
    const { data: promptData, error: promptError } = await supabaseClient.from('prompt').select('prompt, modelo_ia').eq('empresa', empresa_id).eq('tipo_prompt', 'principal') // Ou o tipo correto para este orquestrador
    .single();
    if (promptError) throw new Error(`Nenhum prompt principal encontrado para a empresa.`);
    const { data: apiKeyData, error: apiKeyError } = await supabaseClient.from('api_keys').select('openai_api_key').eq('empresa_id', empresa_id).single();
    if (apiKeyError || !apiKeyData?.openai_api_key) {
      throw new Error(`Chave de API da OpenAI não encontrada para a empresa.`);
    }
    const openAiApiKey = apiKeyData.openai_api_key;
    // --- 4. GERAÇÃO DO LINK DINÂMICO E INJEÇÃO NO PROMPT ---
    const linkReserva = `https://ajudei.app/reserva/${uuid_identificador}`;
    const systemPromptText = `
      ${promptData.prompt}
      
      INSTRUÇÃO ADICIONAL: O link de reserva exclusivo para este cliente é: ${linkReserva}. Você deve fornecê-lo apenas se o cliente perguntar sobre como fazer, alterar ou cancelar uma reserva.
    `.trim();
    // --- 5. PREPARAÇÃO DA CHAMADA PARA A NOVA API /responses ---
    const openAiPayload = {
      model: promptData.modelo_ia || "gpt-4o-mini",
      input: mensagem,
      instructions: systemPromptText,
      previous_response_id: openai_last_response_id,
      store: true // Garante que a conversa seja armazenada pela OpenAI
    };
    if (isDebugMode) console.warn("... Enviando chamada para a nova API /responses...");
    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify(openAiPayload)
    });
    if (!openAiResponse.ok) {
      const errorBody = await openAiResponse.text();
      throw new Error(`Erro na API da OpenAI (/responses): ${openAiResponse.status} - ${errorBody}`);
    }
    const openAiResult = await openAiResponse.json();
    const new_response_id = openAiResult.id;
    const assistantMessageText = openAiResult.output[0]?.content[0]?.text?.text ?? "Desculpe, não consegui processar sua solicitação.";
    if (isDebugMode) console.warn(`... Resposta da OpenAI recebida. Novo ID de resposta: ${new_response_id}`);
    // --- 6. ATUALIZAÇÃO DO ESTADO E NOTIFICAÇÕES ---
    // Atualiza a "memória" na tabela clientes com o novo ID de resposta
    await supabaseClient.from('clientes').update({
      openai_last_response_id: new_response_id
    }).eq('id', cliente_id);
    // Salva a resposta da IA na tabela chatsZap para log de curto prazo
    await supabaseClient.from('chatsZap').insert({
      instancia,
      chatId,
      tsData: new Date().toISOString(),
      mensagem: assistantMessageText,
      type: 'chat',
      enviado_pelo_operador: true
    });
    // Envia a resposta para o cliente
    fetch(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        cliente_id: cliente_id,
        message: assistantMessageText
      })
    }).catch(console.error);
    return new Response(JSON.stringify({
      success: true,
      message: "Orquestrador stateful executado."
    }));
  } catch (error) {
    console.error('🔥 Erro no Orquestrador Stateful:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
