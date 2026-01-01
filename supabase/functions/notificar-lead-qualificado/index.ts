import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
serve(async (req)=>{
  // Tratamento de CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // 1. Recebendo os parâmetros do n8n
    const { telefone_cliente, empresa_id, resumo_ia, telefone_vendedor, api_url, api_token// (Opcional) Token da sua API
     } = await req.json();
    // Validação simples
    if (!telefone_cliente || !resumo_ia || !telefone_vendedor) {
      throw new Error("Parâmetros obrigatórios: telefone_cliente, resumo_ia, telefone_vendedor");
    }
    // Inicializa Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, supabaseKey);
    // 2. Buscando o Contrato e os Arquivos
    // Fazemos um JOIN para trazer tudo de uma vez
    const { data: contrato, error: dbError } = await supabase.from('contratos').select(`
        *,
        contrato_arquivos (
          url,
          tipo,
          nome_arquivo
        )
      `).eq('telefone', telefone_cliente).order('created_at', {
      ascending: false
    }).limit(1).single();
    if (dbError || !contrato) {
      throw new Error("Contrato não encontrado para este telefone.");
    }
    // 3. Formatando a Mensagem
    // Montamos o "card" do lead
    const listaArquivos = contrato.contrato_arquivos && contrato.contrato_arquivos.length > 0 ? contrato.contrato_arquivos.map((f)=>`- 📎 [${f.tipo}] ${f.nome_arquivo || 'Arquivo'}: ${f.url}`).join('\n') : "Nenhum arquivo coletado.";
    const mensagemFinal = `
🔥 *NOVO LEAD QUALIFICADO!* 🔥

👤 *Cliente:* ${contrato.nome || 'Não informado'}
📱 *WhatsApp:* ${contrato.telefone}
🏦 *Banco:* ${contrato.banco || 'N/A'}
💰 *Dívida Estimada:* R$ ${contrato.valor_total_contrato || '0,00'}

🤖 *Análise da IA:*
"${resumo_ia}"

Tb *Arquivos Coletados:*
${listaArquivos}

---------------------------
💡 *Ação Sugerida:* Entrar em contato imediatamente.
    `.trim();
    // 4. Enviando via API de WhatsApp (Exemplo Genérico)
    // Aqui usamos a URL que você vai passar ou uma variável de ambiente
    const endpoint = api_url || Deno.env.get('WHATSAPP_API_URL');
    // Se você não tiver a URL no ENV ou no Body, vai dar erro aqui.
    // Ajuste o body abaixo conforme a documentação da SUA api (waapi, evolution, etc)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_token || Deno.env.get('WHATSAPP_API_TOKEN')}`
      },
      body: JSON.stringify({
        number: telefone_vendedor,
        message: mensagemFinal
      })
    });
    const apiResult = await response.json();
    return new Response(JSON.stringify({
      success: true,
      message: "Lead notificado com sucesso",
      dados_enviados: mensagemFinal,
      api_response: apiResult
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      status: 200
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
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
