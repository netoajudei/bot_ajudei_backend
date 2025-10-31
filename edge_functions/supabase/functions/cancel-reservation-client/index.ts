// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// Define os cabeçalhos CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Inicia o servidor para escutar as requisições
serve(async (req)=>{
  // Lida com a requisição pre-flight do CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  // Ativa/desativa os logs detalhados com base no "Secret"
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // --- 1. Inicialização e Validação ---
    const { compelition_id, tool_call_id, args } = await req.json();
    if (isDebugMode) console.log("Payload recebido em cancel-reserva:", {
      compelition_id,
      tool_call_id,
      args
    });
    if (!compelition_id || !tool_call_id) {
      throw new Error("Payload do orquestrador incompleto. Faltam compelition_id ou tool_call_id.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    if (isDebugMode) console.log("Passo 1: Validação e inicialização concluídas.");
    // --- 2. Lógica Principal: Encontrar e Cancelar a Reserva ---
    // Busca o cliente_id a partir do compelition_id
    const { data: compelitionData, error: compelitionError } = await supabaseClient.from('compelition').select('cliente').eq('id', compelition_id).single();
    if (compelitionError || !compelitionData) throw new Error(`Não foi possível encontrar a conversa com ID ${compelition_id}.`);
    const cliente_id = compelitionData.cliente;
    // Encontra a reserva mais recente e ativa do cliente para cancelar
    const { data: reservaParaCancelar, error: reservaError } = await supabaseClient.from('reservas').select('*, empresa!inner(contatoSoReserva)').eq('clientes_id', cliente_id).eq('cancelada_cliente', false).eq('cancelada_casa', false).order('created_at', {
      ascending: false
    }).limit(1).single();
    if (reservaError || !reservaParaCancelar) {
      throw new Error(`Nenhuma reserva ativa encontrada para o cliente ID ${cliente_id} para cancelar.`);
    }
    const reserva_id = reservaParaCancelar.id;
    if (isDebugMode) console.log(`Passo 2.1: Reserva ID ${reserva_id} encontrada para o cliente ${cliente_id}.`);
    // Atualiza a reserva para marcar como cancelada pelo cliente
    const { error: updateError } = await supabaseClient.from('reservas').update({
      cancelada_cliente: true
    }).eq('id', reserva_id);
    if (updateError) {
      throw new Error(`Erro ao cancelar a reserva no banco de dados: ${updateError.message}`);
    }
    if (isDebugMode) console.log(`Passo 2.2: Reserva ${reserva_id} marcada como cancelada.`);
    // --- 3. Notificações ---
    // a) Notificar a equipe da empresa
    const contatosEmpresa = reservaParaCancelar.empresa?.contatoSoReserva;
    if (contatosEmpresa && Array.isArray(contatosEmpresa)) {
      const messageForCompany = `⚠️ Reserva Cancelada pelo Cliente ⚠️\n- Nome: ${reservaParaCancelar.nome}\n- Data: ${reservaParaCancelar.data_reserva}`.trim();
      for (const contactId of contatosEmpresa){
        // *** ALTERAÇÃO APLICADA AQUI: Usa o novo gateway para a equipe ***
        fetch(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            empresa_id: reservaParaCancelar.empresa_id,
            chatId: contactId,
            message: messageForCompany
          })
        }).catch((err)=>console.error(`Falha ao notificar o contato da empresa ${contactId}:`, err));
      }
      if (isDebugMode) console.log("Passo 3.1: Notificações para a empresa enviadas.");
    }
    // --- 4. Reportar o Resultado e Fechar o Ciclo ---
    const toolResult = {
      status: "sucesso",
      message: `A reserva (ID: ${reserva_id}) foi cancelada com sucesso a pedido do cliente.`
    };
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: cliente_id,
      p_new_message: {
        role: 'tool',
        tool_call_id: tool_call_id,
        name: 'reservaDoVaranda',
        content: JSON.stringify(toolResult)
      }
    });
    if (isDebugMode) console.log("Passo 4.1: Histórico da conversa atualizado com o resultado da ferramenta.");
    // Re-invoca a função orquestradora para gerar a resposta final ao cliente
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
    if (isDebugMode) console.log(`Passo 4.2: Função orquestradora 'gemini-compelition' invocada para gerar resposta final.`);
    // --- 5. Retorno de Sucesso ---
    return new Response(JSON.stringify({
      success: true,
      message: "Ação de cancelamento executada e ciclo de feedback iniciado."
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Erro na Edge Function cancel-reserva-cliente:', error);
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
