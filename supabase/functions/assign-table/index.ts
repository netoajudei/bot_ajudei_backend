import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// Define os cabeçalhos CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// --- Função para buscar o ID do perfil do usuário logado ---
async function getUserId(req, supabase) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.id ?? null;
}
// Inicia o servidor para escutar as requisições
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // --- 1. Validação dos Parâmetros de Entrada ---
    const { reserva_id, numero_da_mesa } = await req.json();
    if (isDebugMode) console.log("Payload recebido em assign-table:", {
      reserva_id,
      numero_da_mesa
    });
    if (!reserva_id || !numero_da_mesa) {
      throw new Error("Dados incompletos. É necessário fornecer 'reserva_id' e 'numero_da_mesa'.");
    }
    // --- 2. Inicialização e Verificação de Permissão ---
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    const userId = await getUserId(req, supabaseClient);
    if (!userId) {
      throw new Error("Acesso negado: token de autenticação inválido.");
    }
    // Verifica se o usuário tem a permissão mínima de 'portaria' para esta ação
    const { data: temPermissao, error: rpcError } = await supabaseClient.rpc('verificar_permissao_usuario', {
      p_user_id: userId,
      p_role_requerida: 'portaria'
    });
    if (rpcError || !temPermissao) {
      throw new Error(`Permissão negada. O usuário não tem autorização para atribuir mesas.`);
    }
    if (isDebugMode) console.log(`Usuário ${userId} tem permissão para atribuir mesa.`);
    // --- 3. Ação Principal: Atualizar a Mesa na Reserva ---
    const { data: reservaAtualizada, error: updateError } = await supabaseClient.from('reservas').update({
      mesa: numero_da_mesa
    }).eq('id', reserva_id).select('nome, chat_id, instancia') // Retorna os dados necessários para a notificação
    .single();
    if (updateError || !reservaAtualizada) {
      throw new Error(`Erro ao atualizar a mesa para a reserva ${reserva_id}. Reserva não encontrada ou erro no update: ${updateError?.message}`);
    }
    if (isDebugMode) console.log(`Mesa '${numero_da_mesa}' atribuída com sucesso à reserva ${reserva_id}.`);
    // --- 4. Notificar o Cliente ---
    const messageForClient = `Olá, ${reservaAtualizada.nome}! Uma ótima notícia: sua mesa já foi definida! Ao chegar, por favor, dirija-se à mesa de número **${numero_da_mesa}**. Estamos ansiosos para recebê-lo!`;
    // Invoca a função de envio de mensagem de forma assíncrona
    fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        chatId: reservaAtualizada.chat_id,
        instancia: reservaAtualizada.instancia,
        message: messageForClient
      })
    }).catch((err)=>console.error(`Falha ao notificar o cliente sobre a atribuição da mesa:`, err));
    if (isDebugMode) console.log("Notificação de atribuição de mesa enviada para o cliente.");
    // --- 5. Retorno de Sucesso ---
    return new Response(JSON.stringify({
      success: true,
      message: `Mesa ${numero_da_mesa} atribuída com sucesso à reserva ${reserva_id}.`
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Erro na Edge Function assign-table:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 403
    });
  }
});
