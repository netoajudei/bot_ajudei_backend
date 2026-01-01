/**
 * ===========================================================================
 * Edge Function: enviar-lead-qualificado
 * ===========================================================================
 * 
 * @version 1.0.0
 * @author Neto - Anchieta Financeira
 * @date 2024-12-26
 * 
 * @description
 * Envia dados completos de um lead qualificado via WhatsApp para número
 * específico usando a API api-wa.me. Busca informações do contrato e
 * formata mensagem profissional com todos os detalhes relevantes.
 * 
 * @workflow
 * 1. Recebe cliente_id
 * 2. Busca dados do contrato na tabela contratos
 * 3. Formata mensagem profissional
 * 4. Envia via API api-wa.me
 * 5. Retorna sucesso/erro
 * 
 * @api_integration
 * API: api-wa.me
 * Endpoint: POST https://us.api-wa.me/message/{key}/message/text
 * Body: { "to": "554898519922", "text": "mensagem..." }
 * 
 * @input
 * {
 *   "args": {},
 *   "cliente_id": 123
 * }
 * 
 * @output
 * {
 *   "success": true,
 *   "message": "Lead enviado com sucesso",
 *   "destinatario": "554898519922"
 * }
 */ import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
// ===========================================================================
// CONFIGURAÇÕES
// ===========================================================================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
// Configurações da API WhatsApp
const WHATSAPP_CONFIG = {
  server: "https://us.api-wa.me",
  key: "2697x396224a7d0",
  numero_destino: "554891933112" // Número para receber leads qualificados
};
// ===========================================================================
// HELPER: FORMATAR VALOR MONETÁRIO
// ===========================================================================
function formatarMoeda(valor) {
  if (valor === null || valor === undefined) return "Não informado";
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valor);
}
// ===========================================================================
// HELPER: FORMATAR MENSAGEM DO LEAD
// ===========================================================================
function formatarMensagemLead(contrato, cliente) {
  const linhas = [];
  // Cabeçalho
  linhas.push("🎯 *NOVO LEAD QUALIFICADO*");
  linhas.push("━━━━━━━━━━━━━━━━━━━━━━");
  linhas.push("");
  // Dados do Cliente
  linhas.push("👤 *DADOS DO CLIENTE*");
  linhas.push(`Nome: ${contrato.nome || "Não informado"}`);
  linhas.push(`Telefone: ${contrato.telefone || cliente.chatId}`);
  if (contrato.nome_pai) {
    linhas.push(`Pai: ${contrato.nome_pai}`);
  }
  if (contrato.nome_mae) {
    linhas.push(`Mãe: ${contrato.nome_mae}`);
  }
  linhas.push("");
  // Dados do Contrato
  linhas.push("📋 *DADOS DO CONTRATO*");
  linhas.push(`Banco: ${contrato.banco || "Não informado"}`);
  linhas.push(`Nº Contrato: ${contrato.numero_contrato || "Não informado"}`);
  linhas.push("");
  // Informações Financeiras
  linhas.push("💰 *INFORMAÇÕES FINANCEIRAS*");
  if (contrato.parcelas) {
    linhas.push(`Total de Parcelas: ${contrato.parcelas}`);
  }
  if (contrato.valor_parcela) {
    linhas.push(`Valor da Parcela: ${formatarMoeda(contrato.valor_parcela)}`);
  }
  if (contrato.parcelas_pagas) {
    linhas.push(`Parcelas Pagas: ${contrato.parcelas_pagas}`);
  }
  if (contrato.parcelas_em_aberto) {
    linhas.push(`Parcelas em Aberto: ${contrato.parcelas_em_aberto}`);
  }
  if (contrato.parcelas_atrasadas) {
    linhas.push(`⚠️ Parcelas Atrasadas: ${contrato.parcelas_atrasadas}`);
  }
  if (contrato.valor_total_contrato) {
    linhas.push(`Valor Total: ${formatarMoeda(contrato.valor_total_contrato)}`);
  }
  if (contrato.valor_estimado_quitacao) {
    linhas.push(`💵 Valor Estimado Quitação: ${formatarMoeda(contrato.valor_estimado_quitacao)}`);
  }
  if (contrato.percentual_desconto) {
    linhas.push(`🏷️ Desconto: ${contrato.percentual_desconto}%`);
  }
  linhas.push("");
  // Observações
  if (contrato.observacoes && contrato.observacoes.trim()) {
    linhas.push("📝 *OBSERVAÇÕES*");
    linhas.push(contrato.observacoes);
    linhas.push("");
  }
  // Status
  linhas.push("📊 *STATUS*");
  linhas.push(`Situação: ${contrato.status || "novo"}`);
  linhas.push(`Data de Cadastro: ${new Date(contrato.created_at).toLocaleDateString('pt-BR')}`);
  if (contrato.updated_at && contrato.updated_at !== contrato.created_at) {
    linhas.push(`Última Atualização: ${new Date(contrato.updated_at).toLocaleDateString('pt-BR')}`);
  }
  linhas.push("");
  linhas.push("━━━━━━━━━━━━━━━━━━━━━━");
  linhas.push("⏰ Enviado em: " + new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo'
  }));
  return linhas.join("\n");
}
// ===========================================================================
// SERVIDOR HTTP PRINCIPAL
// ===========================================================================
serve(async (req)=>{
  // =========================================================================
  // PREFLIGHT (OPTIONS)
  // =========================================================================
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  const isDebugMode = Deno.env.get("DEBUG_MODE") === "true";
  try {
    // =======================================================================
    // 1. VALIDAR PAYLOAD
    // =======================================================================
    const body = await req.json();
    const { args, cliente_id, clientes_id } = body || {};
    let id_cliente = cliente_id || clientes_id;
    if (!id_cliente || id_cliente === "undefined" || id_cliente === "null") {
      console.error("[Enviar Lead] ❌ Payload recebido:", JSON.stringify(body, null, 2));
      throw new Error("O campo 'cliente_id' ou 'clientes_id' é obrigatório e não foi fornecido corretamente.");
    }
    id_cliente = parseInt(id_cliente);
    if (isNaN(id_cliente)) {
      console.error("[Enviar Lead] ❌ ID inválido:", body);
      throw new Error(`ID do cliente inválido: ${cliente_id || clientes_id}`);
    }
    if (isDebugMode) {
      console.warn("=".repeat(70));
      console.warn("[Enviar Lead Qualificado] 🚀 INICIANDO");
      console.warn(`   cliente_id: ${id_cliente} (tipo: ${typeof id_cliente})`);
      console.warn(`   Payload completo:`, JSON.stringify(body, null, 2));
      console.warn("=".repeat(70));
    }
    // =======================================================================
    // 2. INICIALIZAR SUPABASE CLIENT
    // =======================================================================
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);
    // =======================================================================
    // 3. BUSCAR DADOS DO CLIENTE
    // =======================================================================
    if (isDebugMode) console.warn("\n[Enviar Lead] 📊 Buscando dados do cliente...");
    console.warn(`[DEBUG] ANTES DA QUERY`);
    console.warn(`   id_cliente = ${id_cliente}`);
    console.warn(`   tipo = ${typeof id_cliente}`);
    console.warn(`   valor numérico = ${Number(id_cliente)}`);
    const clienteId = Number(id_cliente);
    console.warn(`   clienteId convertido = ${clienteId}`);
    const { data: cliente, error: errCliente } = await supabase.from("clientes").select("id, chatId, nome").eq("id", clienteId).single();
    console.warn(`[DEBUG] DEPOIS DA QUERY`);
    console.warn(`   data:`, cliente);
    console.warn(`   error:`, errCliente);
    // =======================================================================
    // 4. BUSCAR DADOS DO CONTRATO
    // =======================================================================
    if (isDebugMode) console.warn("\n[Enviar Lead] 📋 Buscando dados do contrato...");
    console.warn(`[DEBUG] Buscando contrato para cliente_id: ${id_cliente}`);
    const { data: contrato, error: errContrato } = await supabase.from("contratos").select("*").eq("cliente_id", id_cliente) // ← CORRIGIDO!
    .order("created_at", {
      ascending: false
    }).limit(1).single();
    console.warn(`[DEBUG] Resultado contrato:`, {
      found: !!contrato,
      error: errContrato
    });
    if (errContrato || !contrato) {
      console.error(`[DEBUG] Erro ao buscar contrato:`, errContrato);
      throw new Error(`Contrato não encontrado para cliente ${id_cliente}: ${errContrato?.message}`);
    }
    // =======================================================================
    // 5. FORMATAR MENSAGEM
    // =======================================================================
    if (isDebugMode) console.warn("\n[Enviar Lead] 📝 Formatando mensagem...");
    const mensagem = formatarMensagemLead(contrato, cliente);
    if (isDebugMode) {
      console.warn(`   ✅ Mensagem formatada (${mensagem.length} caracteres)`);
      console.warn("\n--- PREVIEW DA MENSAGEM ---");
      console.warn(mensagem.substring(0, 300) + "...");
      console.warn("--- FIM PREVIEW ---\n");
    }
    // =======================================================================
    // 6. ENVIAR VIA WHATSAPP (API api-wa.me)
    // =======================================================================
    console.warn("\n[Enviar Lead] 📱 Enviando via WhatsApp...");
    const whatsappEndpoint = `${WHATSAPP_CONFIG.server}/${WHATSAPP_CONFIG.key}/message/text`;
    const whatsappPayload = {
      to: WHATSAPP_CONFIG.numero_destino,
      text: mensagem
    };
    console.warn(`   📍 URL: ${whatsappEndpoint}`);
    console.warn(`   📞 Destino: ${WHATSAPP_CONFIG.numero_destino}`);
    console.warn(`   📦 Payload completo:`, JSON.stringify(whatsappPayload, null, 2));
    const whatsappResponse = await fetch(whatsappEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(whatsappPayload)
    });
    console.warn("\n[WhatsApp API] 📥 RESPOSTA COMPLETA:");
    console.warn(`   Status: ${whatsappResponse.status} ${whatsappResponse.statusText}`);
    console.warn(`   Headers:`, Object.fromEntries(whatsappResponse.headers.entries()));
    const responseText = await whatsappResponse.text();
    console.warn(`   Body (raw):`, responseText);
    let whatsappResult;
    try {
      whatsappResult = JSON.parse(responseText);
      console.warn(`   Body (parsed):`, JSON.stringify(whatsappResult, null, 2));
    } catch (e) {
      console.warn(`   ⚠️ Não foi possível parsear como JSON`);
      whatsappResult = {
        raw: responseText
      };
    }
    if (!whatsappResponse.ok) {
      console.error(`   ❌ ERRO HTTP ${whatsappResponse.status}`);
      throw new Error(`Erro ao enviar WhatsApp: ${whatsappResponse.status} - ${responseText}`);
    }
    console.warn(`   ✅ WhatsApp enviado com sucesso`);
    // =======================================================================
    // 7. ATUALIZAR STATUS DO CONTRATO (OPCIONAL)
    // =======================================================================
    if (isDebugMode) console.warn("\n[Enviar Lead] 🔄 Atualizando status...");
    await supabase.from("contratos").update({
      status: "enviado",
      updated_at: new Date().toISOString()
    }).eq("id", contrato.id);
    if (isDebugMode) {
      console.warn(`   ✅ Status atualizado para "enviado"`);
    }
    // =======================================================================
    // 8. RETORNAR SUCESSO
    // =======================================================================
    if (isDebugMode) {
      console.warn("\n" + "=".repeat(70));
      console.warn("[Enviar Lead] ✅ CONCLUÍDO COM SUCESSO");
      console.warn("=".repeat(70));
    }
    return new Response(JSON.stringify({
      success: true,
      message: "Lead qualificado enviado com sucesso via WhatsApp",
      destinatario: WHATSAPP_CONFIG.numero_destino,
      contrato_id: contrato.id,
      cliente_nome: contrato.nome || cliente.nome,
      caracteres_enviados: mensagem.length
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      status: 200
    });
  } catch (error) {
    // =========================================================================
    // TRATAMENTO DE ERROS
    // =========================================================================
    console.error("🔥 [Enviar Lead] ERRO:", error);
    console.error("Stack:", error.stack);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || "Erro desconhecido"
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
