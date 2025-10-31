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
    // 1. Recebe o payload do webhook (ex: Postman, WAAPI)
    const body = await req.json();
    if (!body || !body.data || !body.instanceId) {
      throw new Error("Payload inválido. 'data' ou 'instanceId' não encontrados.");
    }
    const { data, instanceId } = body;
    const message = data.message;
    if (!message || !message.from || !message.body) {
      throw new Error("Payload da mensagem incompleto.");
    }
    if (isDebugMode) console.warn("▶️ [Webhook de Teste] Iniciado.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // 2. Encontra a empresa pela instância
    const { data: empresaData, error: empresaError } = await supabaseClient.from('empresa').select('id').eq('instanciaChat', instanceId).single();
    if (empresaError || !empresaData) throw new Error(`Empresa não encontrada para a instância: ${instanceId}`);
    const empresa_id = empresaData.id;
    if (isDebugMode) console.warn(`... Empresa encontrada: ID ${empresa_id}`);
    // 3. Encontra ou Cria o Cliente
    let cliente_id;
    const { data: clienteExistente } = await supabaseClient.from('clientes').select('id').eq('chatId', message.from).eq('empresa_id', empresa_id).single();
    if (clienteExistente) {
      cliente_id = clienteExistente.id;
      if (isDebugMode) console.warn(`... Cliente existente encontrado: ID ${cliente_id}`);
    } else {
      if (isDebugMode) console.warn(`... Cliente não encontrado. Criando um novo...`);
      const { data: novoCliente, error: insertClienteError } = await supabaseClient.from('clientes').insert({
        chatId: message.from,
        instancia: instanceId,
        empresa_id: empresa_id,
        nome: message._data?.notifyName || 'Cliente'
      }).select('id').single();
      if (insertClienteError) throw insertClienteError;
      cliente_id = novoCliente.id;
      if (isDebugMode) console.warn(`... Novo cliente criado: ID ${cliente_id}`);
    }
    // 4. Encontra ou Cria a Conversa (Compelition) e anexa a mensagem
    let compelition_id;
    const { data: compelitionExistente } = await supabaseClient.from('compelition').select('id, chat').eq('cliente', cliente_id).single();
    const novaMensagem = {
      role: 'user',
      content: message.body
    };
    if (compelitionExistente) {
      compelition_id = compelitionExistente.id;
      const chatAtual = compelitionExistente.chat || [];
      const { error: updateError } = await supabaseClient.from('compelition').update({
        chat: [
          ...chatAtual,
          novaMensagem
        ]
      }).eq('id', compelition_id);
      if (updateError) throw updateError;
      if (isDebugMode) console.warn(`... Mensagem anexada à conversa existente: ID ${compelition_id}`);
    } else {
      if (isDebugMode) console.warn(`... Conversa não encontrada. Criando uma nova...`);
      const { data: novaCompelition, error: insertCompelitionError } = await supabaseClient.from('compelition').insert({
        cliente: cliente_id,
        empresa: empresa_id,
        chat: [
          novaMensagem
        ] // Inicia o chat com a nova mensagem
      }).select('id').single();
      if (insertCompelitionError) throw insertCompelitionError;
      compelition_id = novaCompelition.id;
      if (isDebugMode) console.warn(`... Nova conversa criada: ID ${compelition_id}`);
    }
    // 5. Aciona o Orquestrador Principal
    // *** ALTERAÇÃO APLICADA AQUI ***
    if (isDebugMode) console.warn(`🚀 Acionando o novo 'agente-roteador' com o ID de conversa: ${compelition_id}`);
    fetch(`${supabaseUrl}/functions/v1/agente-roteador`, {
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
      message: "Webhook de teste executado. Roteador acionado."
    }));
  } catch (error) {
    console.error('🔥 Erro no Webhook de Teste:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
