// Edge Function: enviar-link-reserva
// Envia o link de reserva do cliente automaticamente
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
    const { args, compelition_id, tool_call_id, clientes_id } = await req.json();
    if (isDebugMode) {
      console.warn('📎 [Enviar Link] Iniciando...');
      console.warn(`   compelition_id: ${compelition_id}`);
      console.warn(`   clientes_id: ${clientes_id}`);
      console.warn(`   tool_call_id: ${tool_call_id}`);
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 1. Busca o UUID do cliente
    const { data: clienteData, error: clienteError } = await supabaseClient.from('clientes').select('uuid_identificador, nome, chatId').eq('id', clientes_id).single();
    if (clienteError || !clienteData) {
      throw new Error(`Cliente não encontrado: ${clienteError?.message}`);
    }
    const uuid = clienteData.uuid_identificador;
    if (!uuid) {
      throw new Error('Cliente não possui UUID identificador');
    }
    // 2. Gera o link de reserva
    const linkReserva = `https://ajudei.app/reserva/${uuid}`;
    if (isDebugMode) {
      console.warn(`✅ [Enviar Link] Link gerado: ${linkReserva}`);
      console.warn(`   Cliente: ${clienteData.nome}`);
      console.warn(`   UUID: ${uuid}`);
    }
    // 3. Envia o link via WhatsApp
    const mensagem = `🔗 Aqui está seu link exclusivo de reserva:\n\n${linkReserva}\n\nVocê pode usar este link para fazer, alterar ou cancelar suas reservas a qualquer momento! 😊`;
    if (isDebugMode) {
      console.warn(`📤 [Enviar Link] Enviando mensagem...`);
    }
    const sendResponse = await fetch(`${supabaseUrl}/functions/v1/send-whatsapp-gateway`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        cliente_id: clientes_id,
        message: mensagem
      })
    });
    if (!sendResponse.ok) {
      throw new Error(`Erro ao enviar mensagem: ${await sendResponse.text()}`);
    }
    if (isDebugMode) {
      console.warn(`✅ [Enviar Link] Link enviado com sucesso!`);
    }
    // 4. Registra a resposta da tool no chat
    const toolResponse = {
      role: 'tool',
      tool_call_id: tool_call_id,
      content: JSON.stringify({
        success: true,
        message: 'Link de reserva enviado com sucesso para o cliente.',
        link: linkReserva
      })
    };
    await supabaseClient.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: toolResponse
    });
    if (isDebugMode) {
      console.warn(`💾 [Enviar Link] Resposta registrada no chat`);
    }
    // 5. Chama o orquestrador novamente para continuar a conversa
    if (isDebugMode) {
      console.warn(`🔄 [Enviar Link] Chamando orquestrador para continuar...`);
    }
    fetch(`${supabaseUrl}/functions/v1/orquestrador-com-link-dinamico`, {
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
      success: true,
      message: 'Link de reserva enviado',
      link: linkReserva
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('🔥 [Enviar Link] Erro:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
