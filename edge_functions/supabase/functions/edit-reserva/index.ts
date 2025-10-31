// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
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
    // --- 1. Inicialização e Validação ---
    const body = await req.json();
    if (isDebugMode) console.log("Payload recebido em edit-reserva:", body);
    const { compelition_id, tool_call_id, args } = body;
    if (!compelition_id || !tool_call_id || !args) {
      throw new Error("Payload do orquestrador incompleto. Faltam compelition_id, tool_call_id ou args.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    if (isDebugMode) console.log("Passo 1: Validação e inicialização concluídas.");
    // --- 2. Lógica de Busca da Reserva ---
    const { data: compelitionData, error: compelitionError } = await supabaseClient.from('compelition').select('cliente').eq('id', compelition_id).single();
    if (compelitionError) throw new Error(`Não foi possível encontrar a conversa com ID ${compelition_id}.`);
    const cliente_id = compelitionData.cliente;
    const { data: reservaParaEditar, error: reservaError } = await supabaseClient.from('reservas').select('*, empresa!inner(contatoSoReserva)').eq('clientes_id', cliente_id).eq('cancelada_cliente', false).eq('cancelada_casa', false).order('created_at', {
      ascending: false
    }).limit(1).single();
    if (reservaError) throw new Error(`Nenhuma reserva ativa encontrada para o cliente ID ${cliente_id} para editar.`);
    const reserva_id = reservaParaEditar.id;
    if (isDebugMode) console.log(`Passo 2.1: Reserva ID ${reserva_id} encontrada para o cliente ${cliente_id}.`);
    // --- 3. Ação Principal: Atualizar a Reserva para Edição ---
    const dataToUpdate = {
      novo_nome: args.identificacao,
      novo_adultos: args.adultos,
      novo_crianca: args.criancas,
      nova_observacao: args.preferencia,
      editar: true
    };
    Object.keys(dataToUpdate).forEach((key)=>dataToUpdate[key] === undefined && delete dataToUpdate[key]);
    const { error: updateError } = await supabaseClient.from('reservas').update(dataToUpdate).eq('id', reserva_id);
    if (updateError) throw new Error(`Erro ao atualizar a reserva para edição: ${updateError.message}`);
    if (isDebugMode) console.log(`Passo 3.1: Reserva ${reserva_id} marcada para edição.`);
    // --- 4. Notificações ---
    const resumoAlteracoes = `- De: ${reservaParaEditar.adultos} ad, ${reservaParaEditar.criancas ?? 0} cr\n- Para: ${args.adultos ?? '-'} ad, ${args.criancas ?? '-'} cr\n- Nova Obs: ${args.preferencia || 'Nenhuma'}`.trim();
    if (reservaParaEditar.empresa?.contatoSoReserva) {
      const linkReserva = `https://ajudei.flutterflow.app/${reservaParaEditar.chat_id}/${reservaParaEditar.empresa_id}`;
      const messageForCompany = `📝 Solicitação de Alteração de Reserva 📝\n- Reserva ID: ${reserva_id}\n- Nome: ${reservaParaEditar.nome}\n- Alterações:\n${resumoAlteracoes}\n- Acessar reserva: ${linkReserva}`.trim();
      for (const contactId of reservaParaEditar.empresa.contatoSoReserva){
        // *** CORREÇÃO APLICADA AQUI: Usa a função antiga para a equipe ***
        fetch(`${supabaseUrl}/functions/v1/feedback-gateway`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            empresa_id: reservaParaEditar.empresa_id,
            feedback_type: "contatoSoReserva",
            message: messageForCompany
          })
        }).catch(console.error);
      }
      if (isDebugMode) console.log("Passo 4.1: Notificações para a empresa enviadas.");
    }
    const messageForClient = `Olá, ${reservaParaEditar.nome}!\nRecebemos sua solicitação para alterar a reserva da data ${reservaParaEditar.data_reserva}.\nNossa equipe está verificando a disponibilidade e entrará em contato em breve para confirmar.`.trim();
    // *** A chamada para o cliente continua a usar o novo gateway ***
    fetch(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        cliente_id: cliente_id,
        message: messageForClient
      })
    }).catch(console.error);
    if (isDebugMode) console.log("Passo 4.2: Notificação para o cliente enviada.");
    // --- 5. Reportar o Resultado e Fechar o Ciclo ---
    const toolResult = {
      status: "sucesso",
      message: `A solicitação de edição para a reserva ${reserva_id} foi recebida.`
    };
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: cliente_id,
      p_new_message: {
        role: 'tool',
        tool_call_id,
        name: 'reservaDoVaranda',
        content: JSON.stringify(toolResult)
      }
    });
    if (isDebugMode) console.log("Passo 5.1: Histórico da conversa atualizado com o resultado da ferramenta.");
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
    if (isDebugMode) console.log(`Passo 5.2: Função orquestradora re-invocada.`);
    // --- 6. Retorno de Sucesso ---
    return new Response(JSON.stringify({
      success: true,
      message: "Ação de edição executada."
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Erro na Edge Function edit-reserva:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
