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
    // --- 1. Validação do Payload ---
    const { compelition_id, tool_call_id, args, clientes_id, chatId, instancia } = await req.json();
    if (isDebugMode) console.log("Payload recebido em 'recrutamento':", {
      compelition_id,
      tool_call_id,
      args,
      clientes_id,
      chatId,
      instancia
    });
    if (!compelition_id || !tool_call_id || !args || !clientes_id || !chatId || !instancia) {
      throw new Error("Payload do orquestrador incompleto. Faltam dados essenciais.");
    }
    // --- 2. Inicialização e Secrets ---
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Secrets SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.");
    }
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 3. Ação Principal: Notificar a Equipa ---
    if (isDebugMode) console.log("Processando candidatura de emprego...");
    // Busca os contatos da empresa para vagas
    const { data: empresaData, error: empresaError } = await supabaseClient.from('clientes').select('empresa!inner(contato_vagas_de_emprego)').eq('id', clientes_id).single();
    if (empresaError) throw new Error(`Erro ao buscar dados da empresa: ${empresaError.message}`);
    const contatosVagas = empresaData?.empresa?.contato_vagas_de_emprego;
    let notificationSent = false;
    if (contatosVagas && Array.isArray(contatosVagas) && contatosVagas.length > 0) {
      const { nome, cidade, bairro, funcao, tipo_vaga, conducao } = args;
      // *** ALTERAÇÃO SOLICITADA AQUI ***
      // Transforma o chatId (ex: 5548...@c.us) num link clicável do WhatsApp.
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
- **Condução Própria:** ${conducao || 'Não informado'}
---
**Entrar em contato com o candidato:**
${linkWhatsappCandidato}
      `.trim();
      // Dispara todas as notificações em paralelo
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
      if (isDebugMode) console.log("Notificações de vaga enviadas para a equipa.");
    } else {
      if (isDebugMode) console.warn("Nenhum contato para vagas de emprego configurado na tabela 'empresa'.");
    }
    // --- 4. Reportar Resultado e Fechar o Ciclo ---
    const toolResult = {
      status: notificationSent ? "sucesso" : "falha_configuracao",
      message: notificationSent ? "As informações do candidato foram enviadas com sucesso para a equipe de RH." : "Ocorreu uma falha ao enviar as informações. A empresa não configurou contatos para receber candidaturas."
    };
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id: tool_call_id,
        name: 'vagasDeEmprego',
        content: JSON.stringify(toolResult)
      }
    });
    // Re-invoca o orquestrador para gerar a resposta final ao cliente
    fetch(`${supabaseUrl}/functions/v1/gemini-compelition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        compelition_id
      })
    }).catch(console.error);
    return new Response(JSON.stringify({
      success: true
    }));
  } catch (error) {
    console.error('Erro na Edge Function recrutamento:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
