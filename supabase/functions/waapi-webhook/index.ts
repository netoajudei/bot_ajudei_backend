// supabase/functions/waapi-webhook/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-waapi-hmac, x-waapi-request-id, x-waapi-instance-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
serve(async (req)=>{
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    // Log headers recebidos
    const headers = Object.fromEntries(req.headers.entries());
    console.log('Headers recebidos:', JSON.stringify(headers, null, 2));
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({
        error: 'Método não permitido'
      }), {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Parse do body da requisição
    const body = await req.json();
    console.log('Body recebido:', JSON.stringify(body, null, 2));
    // Verificar se é um teste simples
    if (body.test) {
      console.log('Requisição de teste detectada');
      return new Response(JSON.stringify({
        message: 'Webhook funcionando!',
        test: true,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Validação básica do payload
    if (!body || !body.data) {
      return new Response(JSON.stringify({
        error: 'Payload inválido - dados não encontrados'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Extrair dados da mensagem
    const { data, event, instanceId } = body;
    // Verificar se é um evento de mensagem
    if (event !== 'message') {
      console.log(`Evento ignorado: ${event}`);
      return new Response(JSON.stringify({
        message: 'Evento processado (ignorado)',
        event
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Filtrar apenas mensagens do tipo 'chat' e 'ptt'
    const messageType = data.message?.type;
    if (messageType && ![
      'chat',
      'ptt'
    ].includes(messageType)) {
      console.log(`Tipo de mensagem ignorado: ${messageType}`);
      return new Response(JSON.stringify({
        message: 'Tipo de mensagem ignorado',
        messageType: messageType
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Enviar o payload COMPLETO para o Xano - SEM ALTERAÇÕES
    const completePayload = {
      data: data,
      event: event,
      instanceId: instanceId // ID da instância
    };
    console.log('Enviando payload completo para Xano...');
    console.log('Tipo de mensagem:', messageType);
    console.log('Tem mídia:', data.media ? 'SIM' : 'NÃO');
    console.log('Tamanho do payload:', JSON.stringify(completePayload).length, 'bytes');
    // Enviar para o endpoint do Xano
    const xanoResponse = await fetch('https://x5ii-4wuf-1p2t.n7c.xano.io/api:OigQ0sFA/webhook2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Supabase Edge Function'
      },
      body: JSON.stringify(completePayload)
    });
    const xanoResponseText = await xanoResponse.text();
    console.log('Resposta do Xano:', xanoResponse.status, xanoResponseText);
    let xanoData;
    try {
      xanoData = JSON.parse(xanoResponseText);
    } catch  {
      xanoData = xanoResponseText;
    }
    // Retornar sucesso
    return new Response(JSON.stringify({
      message: 'Webhook processado com sucesso',
      messageType: messageType,
      hasMedia: data.media ? true : false,
      from: data.message?.from || 'unknown',
      body: data.message?.body || '',
      xanoStatus: xanoResponse.status,
      xanoResponse: xanoData,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Erro no webhook:', error.message);
    console.error('Stack trace:', error.stack);
    return new Response(JSON.stringify({
      error: 'Erro interno do servidor',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
