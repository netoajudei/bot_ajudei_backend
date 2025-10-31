// Esta é a função final e unificada do fluxo de reservas.
// VERSÃO CORRIGIDA: A busca de contatos da equipe foi centralizada
// para garantir o escopo correto da variável e o envio das notificações.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Função auxiliar para formatar a data para o padrão AAAA-MM-DD
function formatDataParaSQL(dataString) {
  if (!dataString || !dataString.includes('/') || dataString.split('/').length !== 2) {
    return null;
  }
  const [day, month] = dataString.split('/');
  const now = new Date();
  let year = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (parseInt(month) < currentMonth) {
    year += 1;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// Função auxiliar para enviar notificações com verificação de erro.
async function sendNotification(url, payload, serviceKey) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.warn(`AVISO: A notificação para ${payload.chatId} falhou com status ${response.status}. Resposta: ${await response.text()}`);
    }
  } catch (error) {
    console.error(`ERRO DE REDE ao enviar notificação para ${payload.chatId}:`, error);
  }
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // 1. Recebe o payload do agente especialista.
    const { compelition_id, tool_call_id, args, clientes_id, chatId, instancia } = await req.json();
    if (!args || !clientes_id) throw new Error("Payload incompleto. Faltam 'args' ou 'clientes_id'.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // Declara as variáveis de mensagem no escopo principal
    let finalAssistantMessage = '';
    let messageForTeam = '';
    let toolResultContent = '';
    // *** CORREÇÃO APLICADA AQUI: Busca de dados centralizada ***
    // Busca os dados do cliente e da empresa uma única vez no início.
    const { data: clienteData } = await supabaseClient.from('clientes').select('empresa_id, empresa!inner(contatoSoReserva)').eq('id', clientes_id).single();
    if (!clienteData) throw new Error("Cliente não encontrado.");
    const empresa_id = clienteData.empresa_id;
    const contatosEquipe = clienteData.empresa.contatoSoReserva;
    // --- LÓGICA DE CANCELAMENTO (PRIORIDADE MÁXIMA) ---
    if (args.cancelar === true) {
      if (isDebugMode) console.warn("Iniciando fluxo de CANCELAMENTO de reserva...");
      const { data: reservaParaCancelar, error: findError } = await supabaseClient.from('reservas').select('id, nome, adultos, criancas, data_reserva').eq('clientes_id', clientes_id).eq('cancelada_cliente', false).eq('cancelada_casa', false).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (findError || !reservaParaCancelar) {
        finalAssistantMessage = "Não encontrei nenhuma reserva ativa em seu nome para cancelar.";
      } else {
        const { error: updateError } = await supabaseClient.from('reservas').update({
          cancelada_cliente: true,
          confirmada: false
        }).eq('id', reservaParaCancelar.id);
        if (updateError) {
          finalAssistantMessage = "Ops! Tivemos um problema ao tentar cancelar sua reserva. Por favor, tente novamente.";
        } else {
          if (contatosEquipe && contatosEquipe.length > 0) {
            const dataFmt = new Date(reservaParaCancelar.data_reserva).toLocaleDateString('pt-BR', {
              timeZone: 'UTC'
            });
            messageForTeam = `
⚠️ *Reserva Cancelada pelo Cliente* ⚠️

Uma reserva de *${reservaParaCancelar.adultos} adultos* e *${reservaParaCancelar.criancas || 0} crianças* para o dia *${dataFmt}* foi cancelada.

*Nome da Reserva:* ${reservaParaCancelar.nome}
                  `.trim();
          }
          finalAssistantMessage = "Sua reserva foi cancelada com sucesso, conforme solicitado. Esperamos vê-lo(a) em breve!";
        }
      }
    } else {
      // --- FLUXO NORMAL DE CRIAÇÃO/EDIÇÃO ---
      const { data: regras, error: regrasError } = await supabaseClient.from('prompt_reserva').select('*').eq('empresa_id', empresa_id).single();
      if (regrasError) throw new Error("Não foi possível carregar as regras de reserva da empresa.");
      let validationError = null;
      const totalPessoas = (args.adultos || 0) + (args.criancas || 0);
      const dataFormatada = args.data ? formatDataParaSQL(args.data) : null;
      if (!dataFormatada && !args.editar) {
        validationError = "A data da reserva é obrigatória.";
      } else {
        if (totalPessoas > 0) {
          if (regras.reservas_desabilitadas) validationError = "Desculpe, não estamos a aceitar novas reservas no momento.";
          else if (totalPessoas < regras.limite_minimo_pessoas || totalPessoas > regras.limite_maximo_pessoas) validationError = `Aceitamos reservas para um mínimo de ${regras.limite_minimo_pessoas} e um máximo de ${regras.limite_maximo_pessoas} pessoas.`;
        }
        if (dataFormatada) {
          const dataReserva = new Date(dataFormatada);
          const diaDaSemana = dataReserva.getDay() + 1;
          if (regras.dias_semana_indisponiveis?.includes(diaDaSemana)) validationError = "Desculpe, não aceitamos reservas para este dia da semana.";
          else if (regras.datas_indisponiveis?.includes(dataFormatada)) validationError = "Desculpe, não teremos disponibilidade para reservas nesta data específica.";
        }
      }
      if (validationError) {
        finalAssistantMessage = validationError;
      } else {
        if (args.editar === true) {
          const { data: reservaParaEditar, error: findError } = await supabaseClient.from('reservas').select('id, nome, adultos, criancas').eq('clientes_id', clientes_id).eq('cancelada_cliente', false).eq('cancelada_casa', false).order('created_at', {
            ascending: false
          }).limit(1).single();
          if (findError || !reservaParaEditar) {
            finalAssistantMessage = "Desculpe, não encontrei nenhuma reserva ativa no seu nome para editar.";
          } else {
            const { error: updateError } = await supabaseClient.from('reservas').update({
              novo_nome: args.identificacao,
              novo_adultos: args.adultos,
              novo_crianca: args.criancas,
              nova_observacao: args.preferencia,
              editar: true,
              confirmada: false
            }).eq('id', reservaParaEditar.id);
            if (updateError) {
              finalAssistantMessage = "Ops! Tivemos um problema ao registar o seu pedido de alteração.";
            } else {
              if (contatosEquipe && contatosEquipe.length > 0) {
                let alteracoes = [];
                if (args.adultos !== reservaParaEditar.adultos) alteracoes.push(`- Adultos: de ${reservaParaEditar.adultos} para ${args.adultos}`);
                if (args.criancas !== reservaParaEditar.criancas) alteracoes.push(`- Crianças: de ${reservaParaEditar.criancas || 0} para ${args.criancas || 0}`);
                messageForTeam = `📝 *Solicitação de Alteração de Reserva*\n\n*Nome:* ${reservaParaEditar.nome}\n*Data:* ${args.data}\n\n*Alterações Solicitadas:*\n${alteracoes.join('\n')}`.trim();
              }
              finalAssistantMessage = "Recebemos o seu pedido de alteração! Nossa equipe irá verificar a disponibilidade e entrará em contato para confirmar. Obrigado!";
            }
          }
        } else {
          const hoje = new Date().toISOString().split('T')[0];
          const { data: reservaExistente } = await supabaseClient.from('reservas').select('id, data_reserva').eq('clientes_id', clientes_id).eq('cancelada_cliente', false).eq('cancelada_casa', false).gte('data_reserva', hoje).limit(1).maybeSingle();
          if (reservaExistente) {
            const dataExistenteFmt = new Date(reservaExistente.data_reserva).toLocaleDateString('pt-BR', {
              timeZone: 'UTC'
            });
            finalAssistantMessage = `Verificamos que você já possui uma reserva ativa para o dia ${dataExistenteFmt}. Gostaria de alterá-la?`;
          } else {
            const { error: insertError } = await supabaseClient.from('reservas').insert({
              nome: args.identificacao,
              clientes_id,
              empresa_id,
              adultos: args.adultos,
              criancas: args.criancas,
              observacoes: args.preferencia,
              data_reserva: dataFormatada,
              chat_id: chatId,
              instancia: instancia
            });
            if (insertError) {
              finalAssistantMessage = "Ops! Tivemos um problema para registar a sua reserva.";
            } else {
              if (contatosEquipe && contatosEquipe.length > 0) {
                messageForTeam = `🆕 *Nova Solicitação de Reserva*\n\n*Nome:* ${args.identificacao}\n*Data:* ${args.data}\n*Convidados:* ${args.adultos || 0} adultos e ${args.criancas || 0} crianças.\n*Observações:* ${args.preferencia || 'Nenhuma'}`.trim();
              }
              finalAssistantMessage = "Sua solicitação de reserva foi criada com sucesso! Nossa equipe irá verificar a disponibilidade e entrará em contato para confirmar. Obrigado!";
            }
          }
        }
      }
    }
    toolResultContent = finalAssistantMessage;
    // --- PONTO DE ENVIO ÚNICO ---
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id,
        name: 'reservaDoVaranda',
        content: toolResultContent
      }
    });
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'assistant',
        content: finalAssistantMessage
      }
    });
    if (isDebugMode) console.log("Histórico atualizado com o resultado e a resposta final.");
    const clientPayload = {
      cliente_id: clientes_id,
      message: finalAssistantMessage
    };
    sendNotification(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, clientPayload, serviceKey);
    if (messageForTeam) {
      // Garante que temos os contatos antes de tentar enviar
      if (contatosEquipe && contatosEquipe.length > 0) {
        const teamPayload = {
          feedback_type: "contatoSoReserva",
          empresa_id: empresa_id,
          message: messageForTeam
        };
        sendNotification(`${supabaseUrl}/functions/v1/feedback-gateway`, teamPayload, serviceKey);
      } else {
        if (isDebugMode) console.warn("... Nenhuma equipe de contato encontrada para enviar feedback.");
      }
    }
    return new Response(JSON.stringify({
      success: true
    }));
  } catch (error) {
    console.error('🔥 Erro na Edge Function create-reserva-com-regras:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
