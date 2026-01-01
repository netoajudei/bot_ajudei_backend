/**
 * =================================================================================
 * DOCUMENTAÇÃO: SALVAR ARQUIVO (VERSÃO FINAL - INSERT NA TABELA FILHA)
 * =================================================================================
 * Descrição:
 * 1. Recebe 'media_id'/'media_url' e 'empresa_id'.
 * 2. Recupera Token e Contrato ID.
 * 3. Baixa a mídia do WhatsApp e sobe para o Storage.
 * 4. INSERE um novo registro na tabela 'contratos_arquivo' vinculando ao contrato.
 *
 * * Payload esperado (JSON):
 * {
 * "media_id": "...",       <-- ID da mídia (Recomendado)
 * "media_url": "...",      <-- URL (Fallback)
 * "empresa_id": "3",
 * "file_name": "foto.jpg",
 * "mime_type": "image/jpeg"
 * }
 * =================================================================================
 */ import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
serve(async (req)=>{
  console.log(`[START] Nova requisição: ${req.method} ${req.url}`);
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);
    const body = await req.json();
    console.log("[STEP 1] Payload recebido:", JSON.stringify(body));
    const { media_id, media_url, empresa_id, file_name, mime_type } = body;
    if (!media_id && !media_url || !empresa_id) {
      throw new Error("Faltam campos: media_id (ou media_url) e empresa_id são obrigatórios.");
    }
    // =====================================================================
    // STEP 2: BUSCAR TOKEN
    // =====================================================================
    console.log(`[STEP 2] Buscando token da empresa ${empresa_id}...`);
    const { data: dadosEmpresa, error: erroEmpresa } = await supabase.from('empresa').select('meta_token').eq('id', empresa_id).single();
    if (erroEmpresa || !dadosEmpresa || !dadosEmpresa.meta_token) {
      throw new Error("Erro: Token do WhatsApp não encontrado na tabela empresa.");
    }
    const whatsappToken = dadosEmpresa.meta_token;
    console.log("[STEP 2 OK] Token recuperado.");
    // =====================================================================
    // STEP 3: OBTER URL DE DOWNLOAD
    // =====================================================================
    let urlFinalParaDownload = media_url;
    if (media_id) {
      console.log(`[STEP 3] Buscando URL fresca para media_id: ${media_id}`);
      const responseGraph = await fetch(`https://graph.facebook.com/v18.0/${media_id}`, {
        headers: {
          'Authorization': `Bearer ${whatsappToken}`
        }
      });
      if (!responseGraph.ok) throw new Error(`Erro API Facebook: ${await responseGraph.text()}`);
      const dadosGraph = await responseGraph.json();
      urlFinalParaDownload = dadosGraph.url;
    }
    if (!urlFinalParaDownload) throw new Error("Não foi possível obter URL de download.");
    // =====================================================================
    // STEP 4: BUSCAR O CONTRATO ID
    // =====================================================================
    console.log(`[STEP 4] Buscando contrato ID...`);
    const { data: contratos, error: erroBusca } = await supabase.from('contratos').select(`id, clientes!inner(empresa_id)`).eq('clientes.empresa_id', empresa_id).limit(1);
    if (erroBusca || !contratos || contratos.length === 0) {
      throw new Error("Nenhum contrato encontrado para esta empresa.");
    }
    const contratoId = contratos[0].id;
    console.log(`[STEP 4 OK] Contrato ID: ${contratoId}`);
    // =====================================================================
    // STEP 5: DOWNLOAD E UPLOAD (STORAGE)
    // =====================================================================
    console.log(`[STEP 5] Baixando imagem...`);
    const imageResponse = await fetch(urlFinalParaDownload, {
      headers: {
        'Authorization': `Bearer ${whatsappToken}`,
        'User-Agent': 'PostmanRuntime/7.26.8'
      }
    });
    if (!imageResponse.ok) throw new Error(`Falha download imagem: Status ${imageResponse.status}`);
    const imageBlob = await imageResponse.blob();
    console.log(`[STEP 5] Download OK. Tamanho: ${imageBlob.size}. Iniciando Upload...`);
    const BUCKET_NAME = 'contratos' // <--- CONFIRA SEU BUCKET
    ;
    const caminhoArquivo = `${empresa_id}/${contratoId}/${Date.now()}_${file_name || 'arquivo.jpg'}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET_NAME).upload(caminhoArquivo, imageBlob, {
      contentType: mime_type || 'image/jpeg',
      upsert: true
    });
    if (uploadError) throw new Error(`Erro Storage: ${uploadError.message}`);
    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(caminhoArquivo);
    const arquivoUrlFinal = publicUrlData.publicUrl;
    console.log("[STEP 5 OK] Arquivo salvo no Storage.");
    // =====================================================================
    // STEP 6: INSERIR NA TABELA 'contratos_arquivo' (FIX DO ERRO)
    // =====================================================================
    // --- CONFIGURAÇÃO DA NOVA TABELA ---
    const NOME_TABELA_ARQUIVOS = 'contrato_arquivos' // Verifique se é singular ou plural (ex: contratos_arquivos)
    ;
    const COLUNA_FK_CONTRATO = 'contrato_id' // Nome da coluna que liga ao contrato
    ;
    const COLUNA_URL_ARQUIVO = 'url' // Nome da coluna que guarda o link
    ;
    console.log(`[STEP 6] Criando registro na tabela '${NOME_TABELA_ARQUIVOS}'...`);
    const { data: insertData, error: insertError } = await supabase.from(NOME_TABELA_ARQUIVOS).insert({
      [COLUNA_FK_CONTRATO]: contratoId,
      [COLUNA_URL_ARQUIVO]: arquivoUrlFinal
    }).select();
    if (insertError) {
      console.error("[ERRO STEP 6]", insertError);
      throw new Error(`Erro ao inserir na tabela de arquivos: ${insertError.message}`);
    }
    console.log("[STEP 6 OK] Registro criado com sucesso.");
    return new Response(JSON.stringify({
      message: "Arquivo salvo e vinculado com sucesso!",
      id_arquivo: insertData[0]?.id,
      url: arquivoUrlFinal
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.error("[EXCEPTION]", err);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
