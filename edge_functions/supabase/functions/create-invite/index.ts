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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error("Token de autorização não fornecido.");
    const token = authHeader.replace('Bearer ', '');
    // --- 1. Validação do Payload e Inicialização ---
    const { email_convidado, url_finalizacao } = await req.json();
    if (!email_convidado) throw new Error("O email do convidado é obrigatório.");
    if (!url_finalizacao) throw new Error("A URL de finalização do cadastro é obrigatória.");
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) throw new Error("Variáveis de ambiente não configuradas.");
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);
    // --- 2. Verificação de Permissão ---
    const supabaseUserClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
    const { data: { user } } = await supabaseUserClient.auth.getUser();
    if (!user) throw new Error("Token de gerente inválido ou expirado.");
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
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email_convidado, {
      redirectTo: url_finalizacao,
      data: {
        empresa_id: gerenteProfile.empresa_id
      }
    });
    if (error) {
      // Re-lança o erro para ser apanhado pelo bloco catch principal
      throw error;
    }
    // *** CORREÇÃO 1: Adicionando cabeçalhos CORS à resposta de sucesso ***
    return new Response(JSON.stringify({
      success: true,
      message: "Convite enviado com sucesso!"
    }), {
      headers: corsHeaders
    });
  } catch (error) {
    console.error('Erro na Edge Function create-invite:', error);
    // *** CORREÇÃO 2: Gestão de erro personalizada ***
    // Verifica se a mensagem de erro é a de usuário já existente.
    if (error.message && error.message.includes("A user with this email address has already been registered")) {
      return new Response(JSON.stringify({
        // Retorna a sua mensagem personalizada
        error: "Este email já foi cadastrado no sistema."
      }), {
        status: 409,
        headers: corsHeaders
      });
    }
    // Para todos os outros erros, retorna a mensagem padrão.
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 400,
      headers: corsHeaders
    });
  }
});
