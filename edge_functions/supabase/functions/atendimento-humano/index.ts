// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Função auxiliar para tratar valores nulos ou vazios
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
    // 1. Recebe o payload padronizado do agente especialista.
    const { compelition_id, tool_call_id, args, clientes_id, chatId, instancia } = await req.json();
    if (!args || !clientes_id) throw new Error("Payload incompleto. Faltam 'args' ou 'clientes_id'.");
    if (isDebugMode) console.warn("▶️ [Agente Atendimento Humano] Iniciado.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Busca os contatos de reserva/emergência da empresa.
    const { data: clienteData } = await supabaseClient.from('clientes').select('empresa!inner(contatoSoReserva)').eq('id', clientes_id).single();
    if (!clienteData) throw new Error("Cliente não encontrado.");
    const contatosEquipe = clienteData.empresa?.contatoSoReserva;
    let notificationSent = false;
    // 3. Formata e envia a notificação para a equipe.
    if (contatosEquipe && Array.isArray(contatosEquipe) && contatosEquipe.length > 0) {
      const resumo = getValueOrDefault(args.resumo_menssagem_cliente);
      // Cria o link clicável do WhatsApp para o cliente
      const numeroCliente = chatId.split('@')[0];
      const linkWhatsApp = `https://wa.me/${numeroCliente}`;
      const messageForTeam = `
🚨 *SOLICITAÇÃO DE ATENDIMENTO HUMANO* 🚨
---
Um cliente precisa de ajuda imediata.

🗣️ *Resumo da Solicitação:*
_"${resumo}"_

🔗 *Falar com o cliente agora:*
${linkWhatsApp}
      `.trim();
      // Envia a mensagem para todos os contatos da lista.
      const notificationPromises = contatosEquipe.map((contactId)=>fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            chatId: contactId,
            instancia,
            message: messageForTeam
          })
        }).catch((err)=>console.error(`Falha ao notificar ${contactId}:`, err)));
      await Promise.all(notificationPromises);
      notificationSent = true;
      if (isDebugMode) console.warn("... Notificação de atendimento humano enviada para a equipe.");
    } else {
      if (isDebugMode) console.warn("... Nenhum contato de reserva/emergência configurado na tabela 'empresa'.");
    }
    // 4. Prepara a resposta final para o cliente e o resultado da ferramenta.
    let toolResult;
    let finalAssistantMessage = '';
    if (notificationSent) {
      toolResult = {
        status: "sucesso",
        message: "A solicitação do cliente foi encaminhada para a equipe de atendimento."
      };
      finalAssistantMessage = "Entendido. Já encaminhei sua solicitação para um de nossos atendentes. Por favor, aguarde um momento, alguém da nossa equipe irá entrar em contato com você diretamente por aqui. 👍";
    } else {
      toolResult = {
        status: "falha_configuracao",
        message: "A empresa não configurou um canal para atendimento humano."
      };
      finalAssistantMessage = "Peço desculpas, mas não consegui encontrar um atendente disponível no momento. Por favor, tente entrar em contato por outro canal.";
    }
    // 5. Reporta o resultado da ferramenta de volta para o histórico.
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id,
        name: 'enviar_solicitacao_cliente',
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
    // 7. Envia a resposta final para o cliente.
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
    console.error('🔥 Erro na Edge Function atendimento-humano:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
