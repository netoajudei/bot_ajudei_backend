// Edge Function: finalizar-tool-conversation
// Finaliza tool call criando novo conversation com mensagem fixa
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
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
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    const body = await req.json();
    const { conversation_id, mensagem_fixa, openai_api_key } = body;
    if (isDebugMode) {
      console.warn('[Finalizador Tool] 📥 Recebido');
      console.warn(`   conversation_id: ${conversation_id}`);
      console.warn(`   mensagem_fixa: "${mensagem_fixa}"`);
    }
    // Validações
    if (!conversation_id) {
      throw new Error("O 'conversation_id' é obrigatório.");
    }
    if (!conversation_id.startsWith('conv_')) {
      throw new Error(`conversation_id inválido (formato esperado: conv_XXX): ${conversation_id}`);
    }
    if (!mensagem_fixa) {
      throw new Error("A 'mensagem_fixa' é obrigatória.");
    }
    if (!openai_api_key) {
      throw new Error("A 'openai_api_key' é obrigatória.");
    }
    // ============================================
    // 1. CRIAR NOVA CONVERSATION
    // ============================================
    if (isDebugMode) {
      console.warn('[Finalizador Tool] 🆕 Criando nova conversation...');
    }
    const createConvResponse = await fetch('https://api.openai.com/v1/conversations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openai_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        metadata: {
          tipo: 'atendimento_chatbot',
          migrada_de: conversation_id
        }
      })
    });
    if (!createConvResponse.ok) {
      const errorText = await createConvResponse.text();
      throw new Error(`Erro ao criar conversation: ${errorText}`);
    }
    const newConvData = await createConvResponse.json();
    const novo_conversation_id = newConvData.id;
    if (isDebugMode) {
      console.warn(`✅ Nova conversation criada: ${novo_conversation_id}`);
    }
    // ============================================
    // 2. INSERIR MENSAGEM FIXA NA NOVA CONVERSATION
    // ============================================
    if (isDebugMode) {
      console.warn('[Finalizador Tool] 📝 Inserindo mensagem fixa...');
    }
    const insertResponse = await fetch(`https://api.openai.com/v1/conversations/${novo_conversation_id}/items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openai_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: mensagem_fixa
              }
            ]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Entendido.'
              }
            ]
          }
        ]
      })
    });
    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();
      throw new Error(`Erro ao inserir mensagem: ${errorText}`);
    }
    const insertData = await insertResponse.json();
    if (isDebugMode) {
      console.warn(`✅ Mensagem inserida`);
      console.warn(`   Items inseridos: ${insertData.data?.length || 0}`);
    }
    // ============================================
    // 3. RETORNAR NOVO CONVERSATION_ID
    // ============================================
    if (isDebugMode) {
      console.warn('[Finalizador Tool] ✅ Concluído');
      console.warn(`   Conversation antiga: ${conversation_id} (será deletada pela OpenAI em 30 dias)`);
      console.warn(`   Conversation nova: ${novo_conversation_id}`);
    }
    return new Response(JSON.stringify({
      success: true,
      novo_conversation_id: novo_conversation_id,
      conversation_id_antiga: conversation_id,
      mensagem_inserida: mensagem_fixa
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('[Finalizador Tool] ❌ ERRO:', error.message);
    console.error('[Finalizador Tool] Stack:', error.stack);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
