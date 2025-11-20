import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// Define os cabeçalhos CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Função auxiliar para formatar o número de telefone
function formatarTelefone(ddd, numero) {
  // Remove tudo o que não for dígito
  let numeroLimpo = numero.replace(/\D/g, '');
  // Regra de negócio: Se o número tiver 9 dígitos e começar com '9', remove o primeiro '9'
  if (numeroLimpo.length === 9 && numeroLimpo.startsWith('9')) {
    numeroLimpo = numeroLimpo.substring(1);
  }
  // Validação final do formato
  if (numeroLimpo.length !== 8) {
    throw new Error("Formato de número inválido, ou número não cadastrado no whatsapp. Verifique o numero e tente novamente. O telefone deve ter 8 ou 9 dígitos.");
  }
  return `55${ddd}${numeroLimpo}`;
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
    const { ddd, telefone, empresa_id } = await req.json();
    if (isDebugMode) console.log("Payload recebido em validate-and-find-client:", {
      ddd,
      telefone,
      empresa_id
    });
    if (!ddd || !telefone || !empresa_id) {
      throw new Error("Dados incompletos. É necessário fornecer 'ddd', 'telefone' e 'empresa_id'.");
    }
    // --- 2. Inicialização dos Clientes ---
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const waapiToken = Deno.env.get('WAAPI_TOKEN');
    if (!waapiToken) throw new Error("O segredo WAAPI_TOKEN não foi configurado.");
    const supabaseClient = createClient(supabaseUrl, serviceKey);
    // --- 3. Busca da Instância da Empresa ---
    const { data: empresaData, error: empresaError } = await supabaseClient.from('empresa').select('instanciaChat, fantasia').eq('id', empresa_id).single();
    if (empresaError || !empresaData) {
      throw new Error(`Empresa com ID ${empresa_id} não encontrada.`);
    }
    const instancia = empresaData.instanciaChat;
    // --- 4. Validação do Número via API Externa (waapi.app) ---
    const numeroFormatado = formatarTelefone(ddd, telefone);
    const waapiUrl = `https://waapi.app/api/v1/instances/${instancia}/client/action/get-number-id`;
    if (isDebugMode) console.log(`Validando número ${numeroFormatado} na instância ${instancia}...`);
    const waapiResponse = await fetch(waapiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${waapiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        number: numeroFormatado
      })
    });
    const waapiResult = await waapiResponse.json();
    if (!waapiResponse.ok || waapiResult?.data?.status === 'error') {
      if (isDebugMode) console.log("Resposta da waapi.app: Número inválido.", waapiResult);
      throw new Error("Número de WhatsApp inválido ou não registado.");
    }
    const chatId = waapiResult.data?.data?.numberId?._serialized;
    if (!chatId) throw new Error("A API externa não retornou um chatId válido.");
    if (isDebugMode) console.log(`Número validado com sucesso. ChatId: ${chatId}`);
    // --- 5. Busca ou Criação do Cliente no Banco de Dados ---
    let { data: clienteExistente, error: selectError } = await supabaseClient.from('clientes').select('*').eq('chatId', chatId).eq('empresa_id', empresa_id).maybeSingle(); // Retorna um único registro ou null, sem gerar erro
    if (selectError) throw new Error(`Erro ao buscar cliente: ${selectError.message}`);
    if (clienteExistente) {
      // Cliente já existe, retorna os dados dele
      if (isDebugMode) console.log(`Cliente encontrado: ID ${clienteExistente.id}`);
      return new Response(JSON.stringify({
        success: true,
        cliente: clienteExistente
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 200
      });
    } else {
      // Cliente não existe, cria um novo
      if (isDebugMode) console.log("Cliente não encontrado. Criando um novo...");
      const { data: novoCliente, error: insertError } = await supabaseClient.from('clientes').insert({
        chatId: chatId,
        empresa_id: empresa_id,
        empresa: empresaData.fantasia,
        instancia: instancia,
        // Outros campos podem ser preenchidos com valores padrão ou nulos
        nome: `Cliente ${numeroFormatado}` // Um nome padrão
      }).select().single();
      if (insertError) throw new Error(`Erro ao criar novo cliente: ${insertError.message}`);
      if (isDebugMode) console.log(`Novo cliente criado com sucesso: ID ${novoCliente.id}`);
      return new Response(JSON.stringify({
        success: true,
        cliente: novoCliente
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 200
      });
    }
  } catch (error) {
    console.error('Erro na Edge Function validate-and-find-client:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 400
    });
  }
});
