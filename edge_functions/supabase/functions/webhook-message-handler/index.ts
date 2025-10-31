// Importa os módulos necessários
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// Define os cabeçalhos CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// Inicia o servidor para escutar as requisições
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  // --- LÓGICA DO DEBUG MODE ---
  const isDebugMode = Deno.env.get('DEBUG_MODE') === 'true';
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? '';
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({
        error: 'Método não permitido.'
      }), {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const body = await req.json();
    if (isDebugMode) {
      console.log('Corpo completo do webhook recebido:', JSON.stringify(body, null, 2));
    }
    if (!body || !body.data) {
      return new Response(JSON.stringify({
        error: 'Payload inválido: propriedade "data" não encontrada.'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { data, instanceId } = body;
    const message = data.message;
    // --- PRÉ-VALIDAÇÃO ESSENCIAL ---
    if (!message || !message.from || !message.type || !message._data || message._data.t === undefined) {
      console.error('Payload da mensagem incompleto ou malformado:', JSON.stringify(message, null, 2));
      return new Response(JSON.stringify({
        error: 'Payload da mensagem incompleto.'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // --- FILTRO PARA STATUS DE BROADCAST ---
    if (message.from === 'status@broadcast') {
      if (isDebugMode) {
        console.log("Mensagem de 'status@broadcast' ignorada. Finalizando execução.");
      }
      return new Response('ok: status broadcast ignored', {
        status: 200,
        headers: corsHeaders
      });
    }
    // --- NOVO FILTRO PARA GRUPOS ---
    // Verifica se o 'chatId' (message.from) termina com '@g.us'.
    if (message.from.endsWith('@g.us')) {
      if (isDebugMode) {
        console.log(`Mensagem de grupo (${message.from}) ignorada. Finalizando execução.`);
      }
      // Retorna uma resposta de sucesso para o webhook, mas interrompe o fluxo.
      return new Response('ok: group message ignored', {
        status: 200,
        headers: corsHeaders
      });
    }
    // --- FILTRO PARA MENSAGENS VAZIAS (STICKERS, ETC.) ---
    // Se a mensagem não tem corpo de texto E não é um áudio, ignoramos.
    if (!message.body && message.type !== 'ptt') {
      if (isDebugMode) {
        console.log(`Mensagem do tipo '${message.type}' sem corpo de texto ignorada.`);
      }
      return new Response('ok: unsupported message type ignored', {
        status: 200,
        headers: corsHeaders
      });
    }
    // --- LÓGICA DE TRATAMENTO DA MENSAGEM ---
    let messageContent = message.body || '';
    let hasAudio = false;
    if (message.type === 'ptt') {
      if (isDebugMode) {
        console.log("Mensagem de áudio (ptt) detectada. Usando mensagem padrão.");
      }
      hasAudio = true;
      messageContent = "mensagem de audio informar ao cliente que ainda nao temos recursos para ouvir audio peca que ele digite a pergunta";
    }
    const tsDataFormatted = new Date(message._data.t * 1000).toISOString();
    const dataToInsert = {
      instancia: instanceId,
      chatId: message.from,
      tsData: tsDataFormatted,
      mensagem: messageContent,
      type: message.type,
      temAudio: hasAudio,
      agregado: false,
      menuEstatico: false
    };
    if (isDebugMode) {
      console.log('Dados a serem inseridos no chatsZap:', JSON.stringify(dataToInsert, null, 2));
    }
    // --- INSERÇÃO NO BANCO DE DADOS ---
    const { error } = await supabase.from('chatsZap').insert(dataToInsert);
    if (error) {
      console.error('Erro ao inserir dados no banco de dados Supabase:', error);
      return new Response(JSON.stringify({
        error: 'Falha ao inserir dados no banco de dados.',
        details: error.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (isDebugMode) {
      console.log("Registro criado com sucesso na tabela chatsZap.");
    }
    // --- RETORNO DE SUCESSO ---
    return new Response(JSON.stringify({
      message: 'Mensagem armazenada com sucesso!'
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    // --- CAPTURA DE ERROS INESPERADOS ---
    console.error('Erro inesperado no webhook:', error);
    return new Response(JSON.stringify({
      error: 'Erro interno do servidor.',
      details: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
