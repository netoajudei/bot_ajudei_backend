// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Função auxiliar para tratar valores nulos ou vazios, como no Xano
function getValueOrDefault(value, defaultValue = "não informado") {
  if (value === null || value === undefined || String(value).trim() === "") {
    return defaultValue;
  }
  return value;
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // 1. Recebe o payload padronizado do agente roteador.
    const { compelition_id, tool_call_id, args, clientes_id, chatId, instancia } = await req.json();
    if (!args || !clientes_id) throw new Error("Payload incompleto. Faltam 'args' ou 'clientes_id'.");
    if (isDebugMode) console.warn("▶️ [Agente Parceiros] Iniciado.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Busca os contatos de fornecedores da empresa.
    const { data: clienteData } = await supabaseClient.from('clientes').select('empresa!inner(contato_fornecedores)').eq('id', clientes_id).single();
    if (!clienteData) throw new Error("Cliente não encontrado.");
    const contatosFornecedores = clienteData.empresa?.contato_fornecedores;
    let notificationSent = false;
    // 3. Formata e envia a notificação para a equipe.
    if (contatosFornecedores && Array.isArray(contatosFornecedores) && contatosFornecedores.length > 0) {
      const { contact_reason, customer_info } = args;
      const motivo = getValueOrDefault(contact_reason);
      const nomeFornecedor = getValueOrDefault(customer_info?.name);
      const detalhes = getValueOrDefault(customer_info?.details);
      // Cria o link clicável do WhatsApp
      const numeroFornecedor = chatId.split('@')[0];
      const linkWhatsApp = `https://wa.me/${numeroFornecedor}`;
      const messageForTeam = `
*O parceiro comercial abaixo entrou em contato:*

*Motivo do seu contato:* ${motivo}
*Identificação:* ${nomeFornecedor}
*Detalhes do serviço ou produto:* ${detalhes}

${linkWhatsApp}
      `.trim();
      // Envia a mensagem para o primeiro contato da lista.
      const targetContact = contatosFornecedores[0];
      await fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`
        },
        body: JSON.stringify({
          chatId: targetContact,
          instancia,
          message: messageForTeam
        })
      });
      notificationSent = true;
      if (isDebugMode) console.warn("... Notificação de novo parceiro enviada para a equipe.");
    } else {
      if (isDebugMode) console.warn("... Nenhum contato para fornecedores configurado na tabela 'empresa'.");
    }
    // 4. Prepara a resposta final para o cliente e o resultado da ferramenta.
    let toolResult;
    let finalAssistantMessage = '';
    if (notificationSent) {
      toolResult = {
        status: "sucesso",
        message: "As informações do fornecedor foram encaminhadas para a equipe responsável."
      };
      finalAssistantMessage = "Obrigado pelo seu contato! Suas informações foram encaminhadas para nossa equipe responsável, que entrará em contato se houver interesse. Tenha um ótimo dia!";
    } else {
      toolResult = {
        status: "falha_configuracao",
        message: "A empresa não configurou um contato para receber propostas de fornecedores."
      };
      finalAssistantMessage = "Agradecemos o seu contato. No momento, não estamos a receber propostas através deste canal.";
    }
    // 5. Reporta o resultado da ferramenta de volta para o histórico.
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id,
        name: 'parceirosFornecedores',
        content: JSON.stringify(toolResult)
      }
    });
    // 6. Adiciona a resposta final do assistente ao histórico.
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'assistant',
        content: finalAssistantMessage
      }
    });
    if (isDebugMode) console.warn("... Histórico atualizado com o resultado e a resposta final.");
    // 7. Envia a resposta final para o fornecedor.
    fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        chatId,
        instancia,
        message: finalAssistantMessage
      })
    }).catch(console.error);
    return new Response(JSON.stringify({
      success: true
    }));
  } catch (error) {
    console.error('🔥 Erro na Edge Function novos-parceiros:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
