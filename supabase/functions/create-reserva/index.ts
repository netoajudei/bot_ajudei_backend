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
  try {
    // 1. Recebe todos os parâmetros
    const { compelition_id, tool_call_id, nome, clientes_id, adultos, data, chatId, instancia, criancas, observacoes } = await req.json();
    if (!compelition_id || !tool_call_id) throw new Error("ID da conversa ou da chamada da ferramenta não fornecido.");
    if (!nome || !clientes_id || !adultos || !data) throw new Error("Dados da reserva incompletos.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    const { data: cliente, error: clienteError } = await supabaseClient.from('clientes').select('empresa_id').eq('id', clientes_id).single();
    if (clienteError || !cliente) throw new Error("Cliente não encontrado.");
    // 2. Ação Principal: Cria a reserva no banco de dados
    const { data: novaReserva, error } = await supabaseClient.from('reservas').insert({
      nome,
      clientes_id,
      empresa_id: cliente.empresa_id,
      adultos,
      data_reserva: data,
      chat_id: chatId,
      instancia,
      criancas,
      observacoes,
      confirmada: false,
      cancelada_cliente: false
    }).select('id, empresa_id').single();
    if (error) throw new Error(`Erro ao criar reserva: ${error.message}`);
    // --- LÓGICA DE NOTIFICAÇÃO REINSERIDA ---
    // 3. Notificações para equipe e cliente
    // a) Notificar a equipe da empresa
    const { data: empresaData } = await supabaseClient.from('empresa').select('contatoSoReserva').eq('id', novaReserva.empresa_id).single();
    if (empresaData?.contatoSoReserva && Array.isArray(empresaData.contatoSoReserva)) {
      const linkReserva = `https://ajudei.flutterflow.app/${chatId}/${novaReserva.empresa_id}`;
      const messageForCompany = `
Reserva solicitada:
- Nome: ${nome}
- Data: ${data}
- Convidados: ${adultos} adultos, ${criancas ?? 0} crianças
- Solicitações: ${observacoes || 'Nenhuma'}
Acessar reserva: ${linkReserva}
        `.trim();
      for (const contactId of empresaData.contatoSoReserva){
        // *** ALTERAÇÃO APLICADA AQUI: Usa o novo gateway para a equipe ***
        fetch(`${supabaseUrl}/functions/v1/feedback-gateway`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            empresa_id: novaReserva.empresa_id,
            feedback_type: "contatoSoReserva",
            message: messageForCompany
          })
        }).catch((err)=>console.error(`Falha ao notificar contato ${contactId}:`, err));
      }
    }
    // b) Notificar o cliente
    const messageForClient = `
Olá, ${nome}! ✨
Sua solicitação de reserva foi recebida com sucesso.

Resumo:
- Data: ${data}
- Adultos: ${adultos}
- Crianças: ${criancas ?? 0}

Estamos verificando a disponibilidade e logo entraremos em contato para confirmar, ok?
    `.trim();
    // *** ALTERAÇÃO APLICADA AQUI: Usa o novo gateway para o cliente ***
    fetch(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        cliente_id: clientes_id,
        message: messageForClient
      })
    }).catch(console.error);
    // 4. Reporta o resultado da ferramenta de volta para o histórico da conversa
    const toolResult = {
      status: "sucesso",
      message: "A solicitação de reserva foi criada e está pendente de aprovação. O cliente e a equipe foram notificados.",
      reserva_id: novaReserva.id
    };
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id: tool_call_id,
        name: 'reservaDoVaranda',
        content: JSON.stringify(toolResult)
      }
    });
    // 5. Re-invoca a função orquestradora para que a IA gere a resposta final
    fetch(`${supabaseUrl}/functions/v1/gemini-compelition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        compelition_id: compelition_id
      })
    }).catch(console.error);
    return new Response(JSON.stringify({
      success: true,
      message: "Ação da ferramenta executada."
    }));
  } catch (error) {
    console.error('Erro na Edge Function create-reserva:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
