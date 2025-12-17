// ============================================
// EDGE FUNCTION: salvar-arquivo-contrato
// 
// Recebe base64 → Salva no Bucket → Salva URL na tabela
// Uma chamada só, dispara e esquece!
// ============================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Pega os dados da requisição
    const { telefone, tipo_arquivo, base64, mimetype, filename// opcional
     } = await req.json();
    // Validações
    if (!telefone) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Telefone é obrigatório'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!tipo_arquivo || ![
      'foto',
      'pdf'
    ].includes(tipo_arquivo)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'tipo_arquivo deve ser "foto" ou "pdf"'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!base64) {
      return new Response(JSON.stringify({
        success: false,
        error: 'base64 é obrigatório'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Cria cliente Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl, supabaseKey);
    // Define extensão e pasta baseado no tipo
    const extensao = tipo_arquivo === 'foto' ? 'jpg' : 'pdf';
    const pasta = tipo_arquivo === 'foto' ? 'fotos' : 'pdfs';
    const timestamp = Date.now();
    const nomeArquivo = filename || `${telefone}_${timestamp}.${extensao}`;
    const caminhoCompleto = `${pasta}/${nomeArquivo}`;
    // Converte base64 para Uint8Array
    const base64Limpo = base64.replace(/^data:.*?;base64,/, '');
    const binaryString = atob(base64Limpo);
    const bytes = new Uint8Array(binaryString.length);
    for(let i = 0; i < binaryString.length; i++){
      bytes[i] = binaryString.charCodeAt(i);
    }
    // Upload para o Bucket
    const { data: uploadData, error: uploadError } = await supabase.storage.from('contratos').upload(caminhoCompleto, bytes, {
      contentType: mimetype || (tipo_arquivo === 'foto' ? 'image/jpeg' : 'application/pdf'),
      upsert: true // Sobrescreve se já existir
    });
    if (uploadError) {
      console.error('Erro no upload:', uploadError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Erro no upload: ' + uploadError.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Pega URL pública do arquivo
    const { data: urlData } = supabase.storage.from('contratos').getPublicUrl(caminhoCompleto);
    const urlPublica = urlData.publicUrl;
    // Busca ou cria contrato pelo telefone
    const { data: contratoExistente } = await supabase.from('contratos').select('id').eq('telefone', telefone).order('created_at', {
      ascending: false
    }).limit(1).single();
    let contratoId;
    if (contratoExistente) {
      // Atualiza contrato existente
      contratoId = contratoExistente.id;
      const updateData = tipo_arquivo === 'foto' ? {
        foto_contrato: urlPublica
      } : {
        arquivo_contrato: urlPublica
      };
      const { error: updateError } = await supabase.from('contratos').update(updateData).eq('id', contratoId);
      if (updateError) {
        console.error('Erro ao atualizar:', updateError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Erro ao atualizar contrato: ' + updateError.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    } else {
      // Cria novo contrato
      const insertData = {
        telefone,
        status: 'novo',
        ...tipo_arquivo === 'foto' ? {
          foto_contrato: urlPublica
        } : {
          arquivo_contrato: urlPublica
        }
      };
      const { data: novoContrato, error: insertError } = await supabase.from('contratos').insert(insertData).select('id').single();
      if (insertError) {
        console.error('Erro ao criar:', insertError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Erro ao criar contrato: ' + insertError.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      contratoId = novoContrato.id;
    }
    // Retorna sucesso
    return new Response(JSON.stringify({
      success: true,
      contrato_id: contratoId,
      tipo_arquivo,
      url: urlPublica,
      message: `${tipo_arquivo === 'foto' ? 'Foto' : 'PDF'} salvo com sucesso`
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Erro geral:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
