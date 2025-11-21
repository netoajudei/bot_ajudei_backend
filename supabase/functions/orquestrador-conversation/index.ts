// Edge Function: orquestrador-conversation
// Orquestrador usando OpenAI Conversations + compelition.chat (usa só o último turno do usuário)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  const isDebugMode = Deno.env.get("DEBUG_MODE") === "true";
  try {
    const body = await req.json();
    const { cliente_id, compelition_id } = body || {};
    if (!cliente_id) throw new Error("O 'cliente_id' é obrigatório.");
    if (isDebugMode) {
      console.warn("[Orquestrador Conversation] 🚀 Iniciando");
      console.warn(`   cliente_id: ${cliente_id}`);
      if (compelition_id) console.warn(`   compelition_id: ${compelition_id}`);
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);
    // ============================================
    // 1) BUSCAR CLIENTE + EMPRESA
    // ============================================
    const { data: cliente, error: errCliente } = await supabase.from("clientes").select("id, chatId, instancia, conversation_id, empresa_id, mensagemAgregada, empresa(id, em_teste)").eq("id", cliente_id).single();
    if (errCliente || !cliente) throw new Error(`Cliente não encontrado: ${errCliente?.message}`);
    const { conversation_id, empresa_id, chatId, instancia } = cliente;
    const em_teste = cliente.empresa?.em_teste ?? null;
    if (isDebugMode) {
      console.warn(`   empresa_id: ${empresa_id}`);
      console.warn(`   conversation_id: ${conversation_id || "NULL (criar novo)"}`);
    }
    // ============================================
    // 2) BUSCAR PROMPT + API KEY
    // ============================================
    const { data: promptRow, error: errPrompt } = await supabase.from("prompt").select("prompt, tools, modelo_ia").eq("empresa", empresa_id).eq("tipo_prompt", "principal").single();
    if (errPrompt || !promptRow) throw new Error(`Prompt não encontrado: ${errPrompt?.message}`);
    const { data: apiKeyRow, error: errKey } = await supabase.from("api_keys").select("openai_api_key").eq("empresa_id", empresa_id).single();
    if (errKey || !apiKeyRow?.openai_api_key) throw new Error(`API Key da OpenAI não encontrada para empresa ${empresa_id}`);
    const openaiKey = apiKeyRow.openai_api_key;
    const modelo = promptRow.modelo_ia || "gpt-4o-mini";
    // Tools do DB -> formato Responses API
    let tools = [];
    if (promptRow.tools && Array.isArray(promptRow.tools)) {
      tools = promptRow.tools.map((t)=>({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }));
    }
    if (isDebugMode) {
      console.warn(`   modelo: ${modelo}`);
      console.warn(`   tools: ${tools.length}`);
      if (tools.length > 0) console.warn(`   tools names: ${tools.map((t)=>t.name).join(", ")}`);
    }
    // ============================================
    // 3) ÚLTIMA MENSAGEM DO USUÁRIO EM COMPELITION.CHAT
    // ============================================
    let compRow = null;
    if (compelition_id) {
      const { data, error } = await supabase.from("compelition").select("id, chat").eq("id", compelition_id).single();
      if (error) throw new Error(`Erro ao buscar compelition por id: ${error.message}`);
      compRow = data;
    } else {
      const { data, error } = await supabase.from("compelition").select("id, chat").eq("cliente", cliente_id) // coluna correta é 'cliente'
      .order("id", {
        ascending: false
      }).limit(1).maybeSingle();
      if (error) throw new Error(`Erro ao buscar compelition por cliente: ${error.message}`);
      compRow = data ?? null;
    }
    function pickLastUserMessage(chatArr) {
      if (!Array.isArray(chatArr)) return null;
      for(let i = chatArr.length - 1; i >= 0; i--){
        const m = chatArr[i];
        if (m?.role === "user" && typeof m.content === "string" && m.content.trim()) {
          return m.content.trim();
        }
      }
      return null;
    }
    let lastUserInput = pickLastUserMessage(compRow?.chat ?? []);
    if (!lastUserInput) {
      const fallback = (cliente.mensagemAgregada ?? "").trim();
      if (fallback) {
        lastUserInput = fallback;
        if (isDebugMode) console.warn("   ⚠️ Usando fallback: clientes.mensagemAgregada");
      }
    }
    if (!lastUserInput) throw new Error("Nenhuma mensagem recente de usuário encontrada em compelition.chat.");
    // ============================================
    // 4) CRIAR CONVERSATION SE NÃO EXISTIR
    // ============================================
    let currentConversationId = conversation_id;
    if (!currentConversationId) {
      if (isDebugMode) console.warn("[Orquestrador] 📝 Criando nova conversation...");
      const createConvRes = await fetch("https://api.openai.com/v1/conversations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          metadata: {
            cliente_id: String(cliente_id),
            empresa_id: String(empresa_id),
            tipo: "atendimento_chatbot"
          }
        })
      });
      if (!createConvRes.ok) throw new Error(`Erro ao criar conversation: ${await createConvRes.text()}`);
      const convData = await createConvRes.json();
      currentConversationId = convData.id;
      await supabase.from("clientes").update({
        conversation_id: currentConversationId
      }).eq("id", cliente_id);
      if (isDebugMode) console.warn(`✅ Conversation criada: ${currentConversationId}`);
    }
    // ============================================
    // 5) INSTRUCTIONS (com data/hora local)
    // ============================================
    const dataAtual = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo"
    });
    const instructions = `
<data>${dataAtual}</data>

${promptRow.prompt}
`.trim();
    // ============================================
    // 6) CHAMAR RESPONSES API (input = último turno user)
    // ============================================
    if (isDebugMode) console.warn("[Orquestrador] 📤 Enviando mensagem para OpenAI...");
    const responsesPayload = {
      model: modelo,
      conversation: currentConversationId,
      store: true,
      instructions,
      input: lastUserInput,
      tools: tools.length > 0 ? tools : undefined
    };
    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(responsesPayload)
    });
    if (!openaiRes.ok) throw new Error(`Erro OpenAI: ${await openaiRes.text()}`);
    const responseData = await openaiRes.json();
    if (isDebugMode) {
      console.warn(`✅ Response ID: ${responseData.id}`);
      console.warn(`📊 Tokens: Input=${responseData.usage?.input_tokens ?? "?"}, Output=${responseData.usage?.output_tokens ?? "?"}`);
    }
    // ============================================
    // 7) DETECTAR TOOL CALL
    // ============================================
    let toolCallItem = null;
    for (const item of responseData.output || []){
      if (item.type === "function_call") {
        toolCallItem = item;
        if (isDebugMode) console.warn(`🔧 Tool detectada: ${item.name}`);
        break;
      }
    }
    function extractAssistantText(resp) {
      for (const item of resp.output || []){
        if (item.type === "message" && item.role === "assistant") {
          const textPart = item.content?.find((c)=>c.type === "output_text");
          if (textPart?.text) return textPart.text;
        }
      }
      return "";
    }
    // ============================================
    // ROTA A: COM TOOL CALL (com reserva -> enviar-link-reserva)
    // ============================================
    if (toolCallItem) {
      if (isDebugMode) console.warn("[Orquestrador] 🔴 ROTA A: Processando tool call");
      const toolArgs = typeof toolCallItem.arguments === "string" ? JSON.parse(toolCallItem.arguments) : toolCallItem.arguments;
      if (isDebugMode) {
        console.warn(`   Tool: ${toolCallItem.name}`);
        console.warn("   Argumentos:", toolArgs);
      }
      // ID do call (caso a API não retorne, geramos um)
      const tool_call_id = toolCallItem.tool_call_id ?? toolCallItem.id ?? crypto.randomUUID?.() ?? String(Date.now());
      const lower = String(toolCallItem.name || "").toLowerCase();
      let functionToCall = toolCallItem.name;
      let mensagemFixa = `Função ${toolCallItem.name} executada com sucesso.`;
      // ———— MAPEAMENTO DE NOMES PARA RESERVA ————
      if (lower === "aciona_fluxo_reserva" || lower === "acionar_funcao_reserva") {
        functionToCall = "enviar-link-reserva"; // <- avisar backend e enviar link
        mensagemFixa = "Link de reserva enviado ao cliente.";
      } else if (lower === "parceirosfornecedores") {
        functionToCall = "novos-parceiros";
        mensagemFixa = "Dados de fornecedor registrados e enviados aos responsáveis.";
      } else if (lower === "vagasdeemprego") {
        functionToCall = "recrutamento";
        mensagemFixa = "Candidatura registrada. Dados enviados ao RH.";
      }
      if (isDebugMode) console.warn(`🚀 Executando função: ${functionToCall}`);
      // Payload inclui compelition_id e tool_call_id
      const toolPayload = {
        args: toolArgs ?? {},
        clientes_id: cliente_id,
        compelition_id: compelition_id ?? null,
        tool_call_id,
        chatId,
        instancia
      };
      const toolResp = await fetch(`${supabaseUrl}/functions/v1/${functionToCall}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`
        },
        body: JSON.stringify(toolPayload)
      });
      if (!toolResp.ok) {
        const errText = await toolResp.text().catch(()=>"(no body)");
        throw new Error(`Falha ao executar ${functionToCall}: HTTP ${toolResp.status} - ${errText}`);
      }
      if (isDebugMode) console.warn(`✅ Tool ${functionToCall} concluída`);
      // Finaliza a tool (cria nova conversation com mensagem fixa)
      if (isDebugMode) console.warn("🔄 Chamando finalizar-tool-conversation...");
      const { data: finalizadorData, error: errFinalizador } = await supabase.functions.invoke("finalizar-tool-conversation", {
        body: {
          conversation_id: currentConversationId,
          mensagem_fixa: mensagemFixa,
          openai_api_key: openaiKey
        }
      });
      if (errFinalizador) throw new Error(`Erro no finalizador: ${errFinalizador.message}`);
      const novo_conversation_id = finalizadorData.novo_conversation_id;
      if (isDebugMode) {
        console.warn("✅ Finalizador executado");
        console.warn(`   Conversation antiga: ${currentConversationId}`);
        console.warn(`   Conversation nova: ${novo_conversation_id}`);
      }
      await supabase.from("clientes").update({
        conversation_id: novo_conversation_id
      }).eq("id", cliente_id);
      // Mensagem de confirmação amigável
      if (isDebugMode) console.warn("📤 Enviando resposta de confirmação...");
      const confirmPayload = {
        model: modelo,
        conversation: novo_conversation_id,
        store: true,
        instructions,
        input: `A ferramenta ${toolCallItem.name} foi executada com sucesso. ${mensagemFixa}. Confirme ao cliente de forma natural e amigável.`,
        tools: tools.length > 0 ? tools : undefined
      };
      const confirmRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(confirmPayload)
      });
      if (!confirmRes.ok) throw new Error(`Erro na confirmação: ${await confirmRes.text()}`);
      const confirmData = await confirmRes.json();
      let respostaFinal = extractAssistantText(confirmData) || `✅ ${mensagemFixa}`;
      if (isDebugMode) console.warn(`💬 Resposta final: "${respostaFinal.substring(0, 120)}..."`);
      if (em_teste === false) {
        await supabase.functions.invoke("send-whatsapp-gateway", {
          body: {
            cliente_id,
            message: respostaFinal
          }
        });
      }
      await supabase.from("clientes").update({
        mensagemAgregada: "",
        agendado: false
      }).eq("id", cliente_id);
      if (isDebugMode) console.warn("✅ Concluído (ROTA A)");
      return new Response(JSON.stringify({
        success: true,
        rota: "A",
        response_id: confirmData.id,
        conversation_id_nova: novo_conversation_id
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        },
        status: 200
      });
    }
    // ============================================
    // ROTA B: SEM TOOL CALL
    // ============================================
    if (isDebugMode) console.warn("[Orquestrador] 🟢 ROTA B: Resposta normal");
    const respostaIA = extractAssistantText(responseData);
    if (!respostaIA) throw new Error("Resposta vazia da IA");
    if (isDebugMode) console.warn(`💬 Resposta: "${respostaIA.substring(0, 120)}..."`);
    if (em_teste === false) {
      await supabase.functions.invoke("send-whatsapp-gateway", {
        body: {
          cliente_id,
          message: respostaIA
        }
      });
    }
    await supabase.from("clientes").update({
      mensagemAgregada: "",
      agendado: false
    }).eq("id", cliente_id);
    if (isDebugMode) console.warn("✅ Concluído (ROTA B)");
    return new Response(JSON.stringify({
      success: true,
      rota: "B",
      response_id: responseData.id,
      conversation_id: currentConversationId
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      status: 200
    });
  } catch (error) {
    console.error("🔥 [Orquestrador Conversation] ERRO:", error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
