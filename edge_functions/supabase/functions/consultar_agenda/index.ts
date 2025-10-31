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
    if (isDebugMode) console.log("Payload recebido em 'consultar-agenda-tool':", {
      compelition_id,
      tool_call_id,
      args,
      clientes_id,
      chatId,
      instancia
    });
    if (!compelition_id || !tool_call_id || !clientes_id || !chatId || !instancia) {
      throw new Error("Payload do orquestrador incompleto. Faltam dados essenciais.");
    }
    // --- 2. Inicialização ---
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
      throw new Error("Secrets SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.");
    }
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 3. Ação Principal: Consultar a Agenda ---
    if (isDebugMode) console.log("Buscando eventos futuros...");
    // Busca a empresa do cliente
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('empresa_id').eq('id', clientes_id).single();
    if (clienteError) throw new Error(`Erro ao buscar empresa do cliente: ${clienteError.message}`);
    // Busca os eventos da empresa a partir de hoje
    const hoje = new Date().toISOString().split('T')[0]; // Formato AAAA-MM-DD
    const { data: eventos, error: eventosError } = await supabaseClient.from('eventos').select('titulo, descricao').eq('empresa_id', clienteData.empresa_id).gte('data_evento', hoje) // gte = Greater Than or Equal (maior ou igual a)
    .order('data_evento', {
      ascending: true
    }).limit(7); // Limita aos próximos 7 eventos para não sobrecarregar
    if (eventosError) throw new Error(`Erro ao buscar eventos: ${eventosError.message}`);
    // --- 4. Formatação e Envio da Mensagem para o Cliente ---
    let agendaMessage = "🗓️ *Nossa Agenda da Semana* 🗓️\n\nConfira o que preparamos para você nos próximos dias:\n";
    let toolContentMessage = "Agenda encontrada: ";
    if (eventos && eventos.length > 0) {
      const eventosFormatados = eventos.map((evento)=>{
        return `\n*${evento.titulo}*\n_${evento.descricao}_`;
      });
      agendaMessage += eventosFormatados.join('\n');
      toolContentMessage += eventos.map((e)=>e.titulo).join(', ');
    } else {
      agendaMessage = "😔 No momento, não temos eventos especiais programados. Fique de olho que em breve teremos novidades!";
      toolContentMessage = "Nenhum evento futuro encontrado na agenda.";
    }
    // Envia a agenda formatada diretamente para o cliente
    fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        chatId,
        instancia,
        message: agendaMessage
      })
    }).catch(console.error);
    if (isDebugMode) console.log("Mensagem com a agenda enviada para o cliente.");
    // --- 5. Reportar Resultado e Fechar o Ciclo ---
    const toolResult = {
      status: "sucesso",
      message: toolContentMessage
    };
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id: tool_call_id,
        name: 'consultar_agenda',
        content: JSON.stringify(toolResult)
      }
    });
    // Re-invoca o orquestrador para gerar a resposta final
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
    console.error('Erro na Edge Function consultar-agenda-tool:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
