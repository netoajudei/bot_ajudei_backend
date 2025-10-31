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
  try {
    // Para esta função, o JWT do gerente logado é crucial.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error("Token de autorização não fornecido.");
    const token = authHeader.replace('Bearer ', '');
    // --- 1. Validação do Payload e Inicialização ---
    const { email_convidado } = await req.json();
    if (!email_convidado) throw new Error("O email do convidado é obrigatório.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) throw new Error("Variáveis de ambiente não configuradas.");
    // Cria um cliente com a chave de serviço para ter privilégios de administrador
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);
    // --- 2. Verificação de Permissão ---
    // Cria um cliente temporário com o token do gerente para verificar suas informações
    const supabaseUserClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
    const { data: { user } } = await supabaseUserClient.auth.getUser();
    if (!user) throw new Error("Token de gerente inválido ou expirado.");
    // Busca o perfil do gerente para obter seu cargo e empresa
    const { data: gerenteProfile, error: gerenteError } = await supabaseAdmin.from('profiles').select('role, empresa_id').eq('id', user.id).single();
    if (gerenteError || !gerenteProfile) throw new Error("Perfil do gerente não encontrado.");
    if (![
      'gerente',
      'adm',
      'proprietario',
      'dev'
    ].includes(gerenteProfile.role)) {
      throw new Error("Permissão negada. Apenas gerentes ou superiores podem enviar convites.");
    }
    // --- 3. Ação Principal: Enviar o Convite Nativo do Supabase ---
    // É AQUI que chamamos a função nativa do Supabase
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email_convidado, {
      // "Anexa" a empresa do gerente ao convite. Isto é a chave do processo.
      data: {
        empresa_id: gerenteProfile.empresa_id
      }
    });
    if (error) {
      throw new Error(`Erro ao enviar o convite: ${error.message}`);
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Convite enviado com sucesso!"
    }));
  } catch (error) {
    console.error('Erro na Edge Function create-invite:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 400,
      headers: corsHeaders
    });
  }
});
