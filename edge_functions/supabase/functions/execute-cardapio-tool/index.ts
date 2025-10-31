// Esta função é um "agente especialista" acionado pelo roteador.
// Sua única responsabilidade é enviar os links dos cardápios para o cliente,
// adaptando-se dinamicamente ao provedor de WhatsApp que a empresa utiliza.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.0';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-control-allow-headers': 'authorization, x-client-info, apikey, content-type'
};
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    // --- 1. Recebe o Payload do Roteador ---
    const { compelition_id, tool_call_id, clientes_id } = await req.json();
    if (!compelition_id || !tool_call_id || !clientes_id) {
      throw new Error('Payload incompleto. Faltam compelition_id, tool_call_id ou clientes_id.');
    }
    if (isDebugMode) console.warn(`▶️ [Agente Cardápio] Iniciado para cliente ID: ${clientes_id}`);
    // Cria um cliente admin para todas as operações no banco
    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    // --- 2. Busca a Configuração Completa (Lógica Corrigida) ---
    // Passo A: Buscar o cliente para obter o empresa_id
    const { data: cliente, error: clienteError } = await supabaseAdmin.from('clientes').select('chatId, empresa_id').eq('id', clientes_id).single();
    if (clienteError || !cliente) {
      throw new Error(`Cliente com ID ${clientes_id} não foi encontrado.`);
    }
    const { chatId, empresa_id } = cliente;
    // Passo B: Buscar os detalhes da empresa
    const { data: empresa, error: empresaError } = await supabaseAdmin.from('empresa').select('api_provider, instanciaChat').eq('id', empresa_id).single();
    if (empresaError || !empresa) {
      throw new Error(`Configurações da empresa com ID ${empresa_id} não foram encontradas.`);
    }
    const { api_provider, instanciaChat } = empresa;
    // Passo C: Buscar as chaves de API para a empresa
    const { data: apiKeysData } = await supabaseAdmin.from('api_keys').select('wa_me_key').eq('empresa_id', empresa_id).single();
    const waMeKey = apiKeysData?.wa_me_key;
    const wappiToken = Deno.env.get('WAPPI_TOKEN'); // WAPPI token vem dos secrets da função
    // --- 3. Define os Cardápios (URLs Estáticas) ---
    // No futuro, estes links podem vir de uma tabela no banco de dados.
    const cardapios = [
      {
        url: "https://ctsvfluufyfhkqlonqio.supabase.co/storage/v1/object/public/varanda.italia//cardapio_almoco_var_italia_abril2025.pdf",
        caption: "Cardápio do Almoço"
      },
      {
        url: "https://ctsvfluufyfhkqlonqio.supabase.co/storage/v1/object/public/varanda.italia//cardapio_noite_var_italia_abril_2025.pdf",
        caption: "Cardápio da Noite"
      }
    ];
    // --- 4. Envia os Cardápios Usando o Provedor Correto ---
    let envioSucesso = true;
    for (const cardapio of cardapios){
      let response;
      switch(api_provider){
        case 'wame':
          if (!waMeKey) {
            console.error(`[ERRO] Provedor é 'wame', mas a chave (wa_me_key) não foi encontrada.`);
            continue;
          }
          // *** ALTERAÇÃO APLICADA AQUI: Mudança de 'image' para 'document' ***
          const apiUrlWame = `https://us.api-wa.me/${waMeKey}/message/document`;
          response = await fetch(apiUrlWame, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            // *** ALTERAÇÃO APLICADA AQUI: Adiciona os campos 'mimetype' e 'fileName' ***
            body: JSON.stringify({
              to: String(chatId).replace('@c.us', ''),
              url: cardapio.url,
              caption: cardapio.caption,
              fileName: `${cardapio.caption}.pdf`,
              mimetype: 'application/pdf' // Define o tipo de ficheiro como PDF
            })
          });
          break;
        case 'wappi':
          if (!wappiToken) {
            console.error(`[ERRO] Provedor é 'wappi', mas o WAPPI_TOKEN não está configurado nos secrets.`);
            continue;
          }
          const apiUrlWappi = `https://waapi.app/api/v1/instances/${instanciaChat}/client/action/send-media`;
          response = await fetch(apiUrlWappi, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${wappiToken}`
            },
            body: JSON.stringify({
              chatId: chatId,
              mediaUrl: cardapio.url,
              caption: cardapio.caption
            })
          });
          break;
        default:
          console.error(`[ERRO] Provedor de API desconhecido: '${api_provider}'.`);
          continue;
      }
      if (!response.ok) {
        envioSucesso = false;
        console.error(`[ERRO] Falha ao enviar o cardápio "${cardapio.caption}":`, await response.text());
      }
    }
    // --- 5. Reporta o Resultado e Finaliza o Ciclo ---
    const toolResult = {
      status: envioSucesso ? "sucesso" : "falha",
      message: envioSucesso ? "Os cardápios foram enviados com sucesso para o cliente." : "Ocorreu um erro ao tentar enviar os cardápios."
    };
    // Adiciona o resultado da ferramenta ao histórico
    await supabaseAdmin.rpc('append_to_compelition_chat', {
      p_cliente_id: clientes_id,
      p_new_message: {
        role: 'tool',
        tool_call_id,
        name: 'execute-cardapio-tool',
        content: JSON.stringify(toolResult)
      }
    });
    // Re-invoca o agente roteador para que ele possa dar a resposta final em texto
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/agente-roteador`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify({
        compelition_id
      })
    });
    if (isDebugMode) console.warn("✅ [Agente Cardápio] Finalizado. Roteador re-invocado para a resposta final.");
    return new Response(JSON.stringify({
      success: true,
      message: "Ação de enviar cardápio executada."
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    console.error('🔥 Erro na Edge Function execute-cardapio-tool:', error.message);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 500
    });
  }
});
