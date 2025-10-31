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
    const { reserva_id } = await req.json();
    if (isDebugMode) console.log("Payload recebido em manual-cancel-reserva:", {
      reserva_id
    });
    if (!reserva_id) {
      throw new Error("Dados incompletos. É necessário fornecer o 'reserva_id'.");
    }
    // --- 2. Inicialização e Verificação de Permissão ---
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    const userId = await getUserId(req, supabaseClient);
    if (!userId) {
      throw new Error("Acesso negado: token de autenticação inválido.");
    }
    // Verifica se o usuário tem a permissão mínima de 'gerente'
    const { data: temPermissao, error: rpcError } = await supabaseClient.rpc('verificar_permissao_usuario', {
      p_user_id: userId,
      p_role_requerida: 'gerente'
    });
    if (rpcError || !temPermissao) {
      throw new Error(`Permissão negada. O usuário não tem autorização para cancelar reservas.`);
    }
    if (isDebugMode) console.log(`Usuário ${userId} tem permissão para cancelar reservas.`);
    // --- 3. Ação Principal: Buscar e Cancelar a Reserva ---
    // Primeiro, busca os dados da reserva para usar nas notificações
    const { data: reservaParaCancelar, error: fetchError } = await supabaseClient.from('reservas').select('*, empresa!inner(contatoSoReserva)').eq('id', reserva_id).single();
    if (fetchError || !reservaParaCancelar) {
      throw new Error(`Erro ao buscar a reserva ${reserva_id}. Reserva não encontrada ou erro na busca: ${fetchError?.message}`);
    }
    // Atualiza a reserva no banco, marcando-a como cancelada pela casa
    const { error: updateError } = await supabaseClient.from('reservas').update({
      cancelada_casa: true
    }).eq('id', reserva_id);
    if (updateError) {
      throw new Error(`Erro ao atualizar o status da reserva ${reserva_id}: ${updateError.message}`);
    }
    if (isDebugMode) console.log(`Reserva ${reserva_id} marcada como cancelada pela casa.`);
    // --- 4. Notificações ---
    // a) Notificar a equipe da empresa
    const contatosEmpresa = reservaParaCancelar.empresa?.contatoSoReserva;
    if (contatosEmpresa && Array.isArray(contatosEmpresa)) {
      const messageForCompany = `
❌ Reserva Cancelada Manualmente ❌
- Por: Operador (ID: ${userId.substring(0, 8)})
- Nome da Reserva: ${reservaParaCancelar.nome}
- Data: ${reservaParaCancelar.data_reserva}
- Convidados: ${reservaParaCancelar.adultos} adultos, ${reservaParaCancelar.criancas ?? 0} crianças
      `.trim();
      for (const contactId of contatosEmpresa){
        fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            chatId: contactId,
            instancia: reservaParaCancelar.instancia,
            message: messageForCompany
          })
        }).catch((err)=>console.error(`Falha ao notificar o contato da empresa ${contactId}:`, err));
      }
    }
    // b) Notificar o cliente, se não for uma reserva anônima
    if (reservaParaCancelar.reserva_anonima === false && reservaParaCancelar.chat_id) {
      const messageForClient = `Olá, ${reservaParaCancelar.nome}. Gostaríamos de informar que, por motivos operacionais, a sua reserva para a data ${reservaParaCancelar.data_reserva} precisou ser cancelada. Pedimos desculpas por qualquer inconveniente.`;
      fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`
        },
        body: JSON.stringify({
          chatId: reservaParaCancelar.chat_id,
          instancia: reservaParaCancelar.instancia,
          message: messageForClient
        })
      }).catch(console.error);
    }
    if (isDebugMode) console.log("Notificações de cancelamento enviadas.");
    // --- 5. Retorno de Sucesso ---
    return new Response(JSON.stringify({
      success: true,
      message: `Reserva ${reserva_id} cancelada com sucesso.`
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Erro na Edge Function manual-cancel-reserva:', error);
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
