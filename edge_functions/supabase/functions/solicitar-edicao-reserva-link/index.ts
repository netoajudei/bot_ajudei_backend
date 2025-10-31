// Esta Edge Function é pública e serve para um cliente EXECUTAR
// a edição de sua reserva a partir de um link seguro.
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
    // 1. Recebe o payload do site com os novos dados da reserva.
    const { cliente_uuid, novo_nome, nova_data_reserva, novos_adultos, novas_criancas, nova_observacao } = await req.json();
    if (!cliente_uuid || !novos_adultos || !nova_data_reserva) {
      throw new Error("Dados incompletos. É necessário fornecer o UUID do cliente, a nova data e o novo número de adultos.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. "Traduz" o UUID seguro para o ID interno do cliente.
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('id').eq('uuid_identificador', cliente_uuid).single();
    if (clienteError || !clienteData) {
      throw new Error(`Cliente com o identificador fornecido não foi encontrado.`);
    }
    const cliente_id = clienteData.id;
    // 3. Busca a reserva ativa mais recente para este cliente.
    const { data: reserva, error: findError } = await supabaseClient.from('reservas').select('id, nome, adultos, criancas, observacoes, empresa_id, data_reserva').eq('clientes_id', cliente_id).eq('cancelada_cliente', false).eq('cancelada_casa', false).gte('data_reserva', new Date().toISOString().split('T')[0]).order('created_at', {
      ascending: false
    }).limit(1).single();
    if (findError || !reserva) {
      throw new Error(`Nenhuma reserva ativa encontrada para este cliente para editar.`);
    }
    // 4. Atualiza a reserva: move os dados antigos para os campos "novo_" e insere os novos dados.
    const { error: updateError } = await supabaseClient.from('reservas').update({
      // Guarda os dados antigos para histórico
      novo_nome: reserva.nome,
      novo_adultos: reserva.adultos,
      novo_crianca: reserva.criancas,
      nova_observacao: reserva.observacoes,
      nova_data: reserva.data_reserva,
      // Atualiza com os novos dados
      nome: novo_nome || reserva.nome,
      data_reserva: nova_data_reserva,
      adultos: novos_adultos,
      criancas: novas_criancas || 0,
      observacoes: nova_observacao,
      // Finaliza o ciclo de edição
      editar: false,
      confirmada: true
    }).eq('id', reserva.id);
    if (updateError) {
      throw new Error(`Ocorreu um erro ao atualizar a sua reserva: ${updateError.message}`);
    }
    // 5. Envia as notificações para o cliente e para a equipe.
    let regulamento = '';
    try {
      const { data: promptData } = await supabaseClient.from('prompt_reserva').select('prompt_texto').eq('empresa_id', reserva.empresa_id).single();
      if (promptData?.prompt_texto) regulamento = promptData.prompt_texto;
    } catch (e) {
      console.warn("Aviso: Regulamento não encontrado.");
    }
    const dataFormatada = new Date(nova_data_reserva).toLocaleDateString('pt-BR', {
      timeZone: 'UTC'
    });
    const dataAntigaFormatada = new Date(reserva.data_reserva).toLocaleDateString('pt-BR', {
      timeZone: 'UTC'
    });
    const messageForClient = `🔄 *Sua Reserva foi Atualizada!* 🔄\n\n` + `Olá, ${novo_nome || reserva.nome}!\n` + `Sua solicitação de alteração foi aprovada com sucesso.\n\n` + `*Novos Detalhes da Reserva:*\n` + `-----------------\n` + `📅 *Data:* ${dataFormatada}\n` + `👤 *Convidados:* ${novos_adultos} adultos e ${novas_criancas || 0} crianças\n` + `📝 *Observações:* ${nova_observacao || 'Nenhuma'}\n` + `-----------------\n\n` + `_Atenção: Por favor, desconsidere qualquer confirmação anterior._\n\n` + `${regulamento}`;
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
    const messageForTeam = `🔄 *Reserva Alterada (Site)*\n\nO cliente *${reserva.nome}* alterou sua reserva.\n\n` + `*De:* ${dataAntigaFormatada}, ${reserva.adultos} adultos e ${reserva.criancas || 0} crianças.\n` + `*Para:* ${dataFormatada}, ${novos_adultos} adultos e ${novas_criancas || 0} crianças.`;
    fetch(`${supabaseUrl}/functions/v1/feedback-gateway`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        empresa_id: reserva.empresa_id,
        feedback_type: 'contatoSoReserva',
        message: messageForTeam
      })
    }).catch(console.error);
    // 6. Retorna uma resposta de sucesso para o site.
    return new Response(JSON.stringify({
      success: true,
      message: "Sua reserva foi alterada com sucesso! Enviamos os novos detalhes para o seu WhatsApp."
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('🔥 Erro na Edge Function solicitar-edicao-reserva-link:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
