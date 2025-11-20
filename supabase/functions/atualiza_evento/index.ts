// supabase/functions/update-event-prompt/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
serve(async (req)=>{
  // --- Bloco de Segurança e Configuração ---
  // A requisição deve ser do tipo POST para maior segurança.
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'Método não permitido'
    }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
  // Inicializa o cliente Supabase com permissões de administrador (service_role)
  // As variáveis de ambiente devem ser configuradas no seu projeto Supabase.
  const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    auth: {
      persistSession: false
    }
  });
  try {
    // --- Extração de Parâmetros ---
    // Extrai o 'empresa_id' do corpo da requisição.
    const { empresa_id } = await req.json();
    if (!empresa_id) {
      throw new Error("O 'empresa_id' é obrigatório no corpo da requisição.");
    }
    // --- 1. Limpeza de Eventos Antigos ---
    // Obtém a data de hoje no formato 'YYYY-MM-DD' para a comparação.
    const hoje = new Date().toISOString().split('T')[0];
    console.log(`Limpando eventos anteriores a ${hoje} para a empresa ${empresa_id}...`);
    const { error: deleteError } = await supabaseClient.from('eventos').delete().eq('empresa_id', empresa_id).lt('data', hoje); // lt = less than (menor que)
    if (deleteError) {
      console.error('Erro ao deletar eventos antigos:', deleteError);
      throw deleteError;
    }
    // --- 2. Busca de Eventos Futuros ---
    console.log(`Buscando eventos futuros (a partir de ${hoje}) para a empresa ${empresa_id}...`);
    const { data: eventos, error: selectError } = await supabaseClient.from('eventos').select('data, titulo, descricao') // Seleciona apenas as colunas necessárias
    .eq('empresa_id', empresa_id).gte('data', hoje) // gte = greater than or equal to (maior ou igual a)
    .order('data', {
      ascending: true
    }); // Organiza em ordem crescente de data
    if (selectError) {
      console.error('Erro ao buscar eventos:', selectError);
      throw selectError;
    }
    // --- 3. Geração do XML ---
    console.log(`Gerando XML com ${eventos.length} evento(s) encontrado(s).`);
    let xmlString = '<agendaSemanal>\n';
    if (eventos && eventos.length > 0) {
      eventos.forEach((evento)=>{
        // Formata a data para dia da semana (opcional mas melhora o prompt)
        const dataEvento = new Date(`${evento.data}T12:00:00Z`); // Adiciona hora para evitar problemas de fuso
        const diaDaSemana = dataEvento.toLocaleDateString('pt-BR', {
          weekday: 'long'
        });
        xmlString += `  <evento data="${evento.data}" dia="${diaDaSemana}">\n`;
        xmlString += `    <titulo>${evento.titulo}</titulo>\n`;
        xmlString += `    <descricao>${evento.descricao}</descricao>\n`;
        xmlString += `  </evento>\n`;
      });
    } else {
      xmlString += '  <!-- Nenhum evento especial agendado para os próximos dias. -->\n';
    }
    xmlString += '</agendaSemanal>';
    // --- 4. Atualização da Tabela 'prompt' ---
    console.log(`Atualizando a tabela 'prompt' para a empresa ${empresa_id}...`);
    const { error: updateError } = await supabaseClient.from('prompt').update({
      eventos: xmlString,
      updated_at: new Date().toISOString()
    }).eq('empresa_id', empresa_id);
    if (updateError) {
      console.error("Erro ao atualizar a tabela 'prompt':", updateError);
      throw updateError;
    }
    // --- Resposta de Sucesso ---
    console.log('Processo concluído com sucesso!');
    return new Response(JSON.stringify({
      success: true,
      message: `Prompt da empresa ${empresa_id} atualizado com sucesso.`
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    // --- Tratamento de Erro Geral ---
    console.error('Ocorreu um erro na Edge Function:', err.message);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
