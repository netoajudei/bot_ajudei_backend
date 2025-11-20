import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// --- Função para buscar o ID do perfil do usuário logado ---
// Retorna o UUID do usuário ou null se não estiver autenticado
async function getUserId(req, supabase) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  return user?.id ?? null;
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // --- 1. Inicialização e Validação ---
    const body = await req.json();
    if (isDebugMode) console.log("Payload recebido em manual-create-reserva:", body);
    const { nome, adultos, data, horario, criancas, observacoes, reserva_anonima, // Dados que podem ser nulos para uma reserva anónima
    clientes_id, chatId, instancia, empresa_id } = body;
    if (!nome || !adultos || !data) {
      throw new Error("Dados incompletos. É necessário fornecer 'nome', 'adultos' e 'data'.");
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 2. Verificação de Permissão ---
    const userId = await getUserId(req, supabaseClient);
    if (!userId) throw new Error("Acesso negado: token de autenticação inválido.");
    // Usa a função RPC para verificar se o usuário logado tem a permissão necessária
    const { data: temPermissao, error: rpcError } = await supabaseClient.rpc('verificar_permissao_usuario', {
      p_user_id: userId,
      p_role_requerida: 'garcon'
    });
    if (rpcError || !temPermissao) {
      throw new Error(`Permissão negada. O usuário não tem autorização para criar reservas. Erro RPC: ${rpcError?.message}`);
    }
    if (isDebugMode) console.log(`Usuário ${userId} tem permissão para criar reserva.`);
    // --- 3. Preparação dos Dados para Inserção ---
    const dataToInsert = {
      nome,
      adultos,
      data_reserva: data,
      horario,
      criancas: criancas ?? 0,
      observacoes,
      reserva_anonima,
      clientes_id,
      chat_id: chatId,
      instancia,
      empresa_id,
      confirmada: true,
      criada_por: userId // Rastreia qual funcionário criou a reserva
    };
    // --- 4. Inserção no Banco de Dados ---
    const { data: novaReserva, error: insertError } = await supabaseClient.from('reservas').insert(dataToInsert).select('*, empresa!inner(contatoSoReserva)').single();
    if (insertError) throw new Error(`Erro ao inserir a reserva no banco de dados: ${insertError.message}`);
    if (isDebugMode) console.log(`Reserva manual criada com sucesso. ID: ${novaReserva.id}`);
    // --- 5. Notificações ---
    // a) Notificar a equipe da empresa
    const contatosEmpresa = novaReserva.empresa?.contatoSoReserva;
    if (contatosEmpresa && Array.isArray(contatosEmpresa)) {
      const messageForCompany = `✅ Reserva Manual Criada ✅\n- Por: Funcionário (ID: ${userId.substring(0, 8)})\n- Nome: ${nome}\n- Data: ${data}\n- Convidados: ${adultos} adultos, ${criancas ?? 0} crianças`.trim();
      for (const contactId of contatosEmpresa){
        fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            chatId: contactId,
            instancia,
            message: messageForCompany
          })
        }).catch((err)=>console.error(`Falha ao notificar o contato da empresa ${contactId}:`, err));
      }
    }
    // b) Notificar o cliente, APENAS se não for uma reserva anónima
    if (reserva_anonima === false && chatId && instancia) {
      const messageForClient = `Olá, ${nome}! Sua reserva para ${adultos} pessoa(s) no dia ${data} foi confirmada pela nossa equipe. Estamos te esperando! 😊`.trim();
      fetch(`${supabaseUrl}/functions/v1/send-whatsapp-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`
        },
        body: JSON.stringify({
          chatId,
          instancia,
          message: messageForClient
        })
      }).catch(console.error);
    }
    // --- 6. Retorno de Sucesso ---
    return new Response(JSON.stringify({
      success: true,
      data: novaReserva
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('Erro na Edge Function manual-create-reserva:', error);
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
