// Esta é a nova função especialista para lidar com candidaturas de emprego.
// Ela notifica a equipe de RH e envia uma resposta final diretamente para o candidato.
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
    // 1. Recebe o payload padronizado do agente roteador.
    const { compelition_id, tool_call_id, args, clientes_id, chatId, instancia } = await req.json();
    if (!args || !clientes_id) throw new Error("Payload incompleto. Faltam 'args' ou 'clientes_id'.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Busca os contatos de RH da empresa.
    const { data: clienteData } = await supabaseClient.from('clientes').select('empresa!inner(contato_vagas_de_emprego)').eq('id', clientes_id).single();
    if (!clienteData) throw new Error("Cliente não encontrado.");
    const contatosVagas = clienteData.empresa?.contato_vagas_de_emprego;
    let notificationSent = false;
    // 3. Formata e envia a notificação para a equipe de RH.
    if (contatosVagas && Array.isArray(contatosVagas) && contatosVagas.length > 0) {
      const { nome, cidade, bairro, funcao, tipo_vaga, conducao } = args;
      const numeroCandidato = chatId.split('@')[0];
      const linkWhatsappCandidato = `https://wa.me/${numeroCandidato}`;
      const messageForTeam = `
📝 **NOVA CANDIDATURA DE EMPREGO** 📝
---
Um candidato enviou suas informações:

- **Nome:** ${nome || 'Não informado'}
- **Cidade:** ${cidade || 'Não informada'}
- **Bairro:** ${bairro || 'Não informado'}
- **Função Desejada:** ${funcao || 'Não informada'}
- **Tipo de Vaga:** ${tipo_vaga || 'Não informado'}
- **Condução Própria:** ${conducao ? 'Sim' : 'Não'}
---
**Entrar em contato com o candidato:**
${linkWhatsappCandidato}
      `.trim();
      const notificationPromises = contatosVagas.map((contactId)=>fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            chatId: contactId,
            instancia: instancia,
            message: messageForTeam
          })
        }).catch((err)=>console.error(`Falha ao notificar ${contactId}:`, err)));
      await Promise.all(notificationPromises);
      notificationSent = true;
    }
    // 4. Prepara a resposta final para o cliente e o resultado da ferramenta.
    let toolResult;
    let finalAssistantMessage = '';
    if (notificationSent) {
      toolResult = {
        status: "sucesso",
        message: "As informações do candidato foram enviadas com sucesso para a equipe de RH."
      };
      finalAssistantMessage = "Obrigado! Suas informações foram enviadas com sucesso para nossa equipe. Entraremos em contato caso haja uma oportunidade compatível com o seu perfil. Boa sorte! 😊";
    } else {
      toolResult = {
        status: "falha_configuracao",
        message: "A empresa não configurou contatos para receber candidaturas."
      };
      finalAssistantMessage = "Peço desculpas, mas no momento não estamos a receber candidaturas através deste canal. Agradecemos o seu interesse!";
    }
    // 5. Reporta o resultado da ferramenta de volta para o histórico.
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id,
        name: 'acionar_evento_vaga_emprego',
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
    if (isDebugMode) console.log("Histórico atualizado com o resultado da ferramenta e a resposta final do assistente.");
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
    console.error('🔥 Erro na Edge Function recrutamento-especialista:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
