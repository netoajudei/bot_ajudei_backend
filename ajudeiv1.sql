

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "http" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."api_provider_type" AS ENUM (
    'wappi',
    'wame',
    'api_oficial'
);


ALTER TYPE "public"."api_provider_type" OWNER TO "postgres";


CREATE TYPE "public"."app_role" AS ENUM (
    'garcon',
    'portaria',
    'metre',
    'gerente',
    'financeiro',
    'adm',
    'proprietario',
    'dev'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE TYPE "public"."modo_ia_type" AS ENUM (
    'prompt_unico',
    'roteador_de_agentes',
    'roteador_com_variaveis',
    'conversation'
);


ALTER TYPE "public"."modo_ia_type" OWNER TO "postgres";


CREATE TYPE "public"."prompt_type" AS ENUM (
    'roteador',
    'reservas',
    'funcionamento',
    'eventos',
    'promocoes',
    'geral',
    'principal'
);


ALTER TYPE "public"."prompt_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agregar_mensagem_chatszap"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    emp_id   bigint;
    emp_nome text;
    cli      RECORD;
    nova_msg text := COALESCE(NEW.mensagem,'');
BEGIN
    /* 1. Empresa pela instância */
    SELECT id, fantasia
    INTO   emp_id, emp_nome
    FROM   public.empresa
    WHERE  "instanciaChat" = NEW.instancia
    LIMIT  1;

    IF emp_id IS NULL THEN
        RAISE WARNING 'Empresa não encontrada para instância %', NEW.instancia;
        RETURN NEW;
    END IF;

    /* 2. Cliente pelo chatId + empresa */
    SELECT *
    INTO   cli
    FROM   public.clientes
    WHERE  "chatId"   = NEW."chatId"
      AND  empresa_id = emp_id
    LIMIT  1;

    /* 3. Cliente existe -------------------------------------------------- */
    IF FOUND THEN
        IF cli.agendado IS FALSE THEN         -- primeira mensagem
            UPDATE public.clientes
            SET "mensagemAgregada" = nova_msg,
                agendado           = TRUE,
                "ultimoChatZap"    = NEW.id,
                modifyed_at        = NOW()
            WHERE id = cli.id;

        ELSE                                   -- já estava agendado
            UPDATE public.clientes
            SET "mensagemAgregada" = CASE
                                          WHEN COALESCE("mensagemAgregada",'') = ''
                                          THEN nova_msg                                   -- nada antes
                                          ELSE "mensagemAgregada" || CHR(10) || nova_msg  -- concatena
                                      END,
                "ultimoChatZap"    = NEW.id,
                modifyed_at        = NOW()
            WHERE id = cli.id;
        END IF;

        RAISE WARNING 'Cliente % processado.', cli.id;

    /* 4. Cliente não existe ---------------------------------------------- */
    ELSE
        INSERT INTO public.clientes (
            instancia,
            "chatId",
            nome,
            empresa,
            empresa_id,
            "mensagemAgregada",
            agendado,
            "ultimoChatZap",
            created_at,
            modifyed_at
        ) VALUES (
            NEW.instancia,
            NEW."chatId",
            COALESCE(NEW."notfyName",''),
            emp_nome,
            emp_id,
            nova_msg,
            TRUE,
            NEW.id,
            NOW(),
            NOW()
        );

        RAISE WARNING 'Novo cliente criado para chatId=%', NEW."chatId";
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."agregar_mensagem_chatszap"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."agregar_mensagem_chatszapschedule"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_empresa_id          bigint;
    v_cliente_record      RECORD;
    v_nova_mensagem       text := COALESCE(NEW.mensagem, '');
BEGIN
    -- Etapa 0: Ignorar gatilho se a mensagem foi enviada pelo próprio sistema
    IF NEW.enviado_pelo_operador = TRUE THEN
        RAISE WARNING '➡️ Gatilho ignorado: Mensagem (chatsZap ID: %) enviada pelo operador.', NEW.id;
        RETURN NEW;
    END IF;

    -- Etapa 1: Encontrar a empresa com base na instância do webhook
    SELECT id INTO v_empresa_id
    FROM public.empresa
    WHERE "instanciaChat" = NEW.instancia
    LIMIT 1;

    IF v_empresa_id IS NULL THEN
        RAISE WARNING '⚠️ Empresa não encontrada para a instância: %. A mensagem (chatsZap ID: %) será ignorada.', NEW.instancia, NEW.id;
        RETURN NEW;
    END IF;

    -- Etapa 2: Localizar ou Criar o Cliente
    SELECT * INTO v_cliente_record
    FROM public.clientes
    WHERE "chatId" = NEW."chatId" AND empresa_id = v_empresa_id
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE WARNING '➕ Cliente com chatId % não encontrado na empresa %. Criando novo registro.', NEW."chatId", v_empresa_id;
        INSERT INTO public.clientes (
            instancia, "chatId", nome, empresa_id, agendado, "mensagemAgregada"
        ) VALUES (
            NEW.instancia, NEW."chatId", COALESCE(NEW."notfyName", ''), v_empresa_id, FALSE, ''
        ) RETURNING * INTO v_cliente_record;
    END IF;

    -- Etapa 3: Processar a Mensagem e Agendar
    IF v_cliente_record.agendado IS FALSE THEN
        RAISE WARNING '⏰ Cliente ID % não estava agendado. Agendando novo processamento.', v_cliente_record.id;
        
        UPDATE public.clientes
        SET "mensagemAgregada" = v_nova_mensagem,
            agendado           = TRUE,
            "ultimoChatZap"    = NEW.id,
            modifyed_at        = NOW()
        WHERE id = v_cliente_record.id;

        -- Usando o type cast (::bigint) para ser explícito e evitar erros
        PERFORM cron.schedule(
            'processar-cliente-' || v_cliente_record.id,
            '20 seconds',
            format('SELECT public.processar_e_arquivar_mensagem((%L)::bigint)', v_cliente_record.id)
        );

    ELSE
        RAISE WARNING '✍️ Cliente ID % já estava agendado. Apenas agregando mensagem.', v_cliente_record.id;
        
        UPDATE public.clientes
        SET "mensagemAgregada" = "mensagemAgregada" || CHR(10) || v_nova_mensagem,
            "ultimoChatZap"    = NEW.id,
            modifyed_at        = NOW()
        WHERE id = v_cliente_record.id;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."agregar_mensagem_chatszapschedule"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."append_to_compelition_chat"("p_cliente_id" bigint, "p_new_message" "jsonb") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  UPDATE public.compelition
  SET chat = COALESCE(chat, '[]'::jsonb) || p_new_message
  WHERE cliente = p_cliente_id;
$$;


ALTER FUNCTION "public"."append_to_compelition_chat"("p_cliente_id" bigint, "p_new_message" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."atribuir_mesa_e_notificar_cliente"("p_reserva_id" bigint, "p_numero_mesa" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_reserva         RECORD;
    v_mensagem        text;
    v_http_response   RECORD;
    v_edge_function_url text;
BEGIN
    -- ========================================================================
    -- ETAPA 1: Validação dos parâmetros de entrada
    -- ========================================================================
    IF p_reserva_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'ID da reserva é obrigatório',
            'error', 'MISSING_RESERVA_ID'
        );
    END IF;

    IF p_numero_mesa IS NULL OR TRIM(p_numero_mesa) = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Número da mesa é obrigatório',
            'error', 'MISSING_MESA_NUMBER'
        );
    END IF;

    -- ========================================================================
    -- ETAPA 2: Buscar informações da reserva
    -- ========================================================================
    SELECT 
        r.id,
        r.chat_id,
        r.nome,
        r.empresa_id,
        r.instancia,
        r.data_reserva,
        r.horario,
        r.cancelada_cliente,
        r.cancelada_casa,
        r.confirmada
    INTO v_reserva
    FROM public.reservas r
    WHERE r.id = p_reserva_id;

    -- Verificar se a reserva existe
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Reserva não encontrada',
            'error', 'RESERVA_NOT_FOUND',
            'reserva_id', p_reserva_id
        );
    END IF;

    -- Validar status da reserva
    IF v_reserva.cancelada_cliente = true THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'A reserva foi cancelada pelo cliente',
            'error', 'RESERVA_CANCELADA_CLIENTE',
            'reserva_id', p_reserva_id
        );
    END IF;

    IF v_reserva.cancelada_casa = true THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'A reserva foi cancelada pela casa',
            'error', 'RESERVA_CANCELADA_CASA',
            'reserva_id', p_reserva_id
        );
    END IF;

    -- Verificar se o chat_id existe
    IF v_reserva.chat_id IS NULL OR TRIM(v_reserva.chat_id) = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Reserva não possui chat_id associado (pode ser reserva anônima)',
            'error', 'MISSING_CHAT_ID',
            'reserva_id', p_reserva_id
        );
    END IF;

    -- ========================================================================
    -- ETAPA 4: Atualizar a reserva com o número da mesa
    -- ========================================================================
    UPDATE public.reservas
    SET mesa = p_numero_mesa
    WHERE id = p_reserva_id;

    RAISE NOTICE '✅ Mesa % atribuída à reserva ID %', p_numero_mesa, p_reserva_id;

    -- ========================================================================
    -- ETAPA 5: Preparar e enviar mensagem via WhatsApp
    -- ========================================================================
    
    -- Verificar se temos cliente_id
    IF v_reserva.clientes_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Reserva não possui cliente_id associado',
            'error', 'MISSING_CLIENTE_ID',
            'reserva_id', p_reserva_id
        );
    END IF;

    -- Construir a mensagem personalizada
    v_mensagem := format(
        E'Olá%s! 🎉\n\nTudo está pronto por aqui e estamos ansiosos em vê-lo(a) em nossa casa! ' ||
        'Sua mesa já está reservada.\n\n📍 *Mesa: %s*\n\n' ||
        'Até breve! ✨',
        CASE 
            WHEN v_reserva.nome IS NOT NULL AND TRIM(v_reserva.nome) != '' 
            THEN ', ' || TRIM(v_reserva.nome)
            ELSE ''
        END,
        p_numero_mesa
    );

    -- URL da Edge Function
    v_edge_function_url := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/send-whatsapp-gateway';

    -- Fazer a chamada HTTP para a Edge Function
    BEGIN
        SELECT status, content::jsonb
        INTO v_http_response
        FROM extensions.http((
            'POST',
            v_edge_function_url,
            ARRAY[
                extensions.http_header('Content-Type', 'application/json'),
                extensions.http_header('Authorization', 'Bearer ' || current_setting('request.headers')::json->>'authorization')
            ],
            'application/json',
            jsonb_build_object(
                'cliente_id', v_reserva.clientes_id,
                'message', v_mensagem
            )::text
        ));

        -- Verificar resposta da Edge Function
        IF v_http_response.status >= 200 AND v_http_response.status < 300 THEN
            RAISE NOTICE '📱 Mensagem enviada com sucesso para cliente_id %', v_reserva.clientes_id;
            
            RETURN jsonb_build_object(
                'success', true,
                'message', 'Mesa atribuída e cliente notificado com sucesso',
                'reserva_id', p_reserva_id,
                'mesa', p_numero_mesa,
                'cliente', v_reserva.nome,
                'cliente_id', v_reserva.clientes_id,
                'whatsapp_response', v_http_response.content
            );
        ELSE
            RAISE WARNING '⚠️ Erro ao enviar mensagem: Status %', v_http_response.status;
            
            RETURN jsonb_build_object(
                'success', false,
                'message', 'Mesa atribuída, mas houve erro ao enviar mensagem no WhatsApp',
                'reserva_id', p_reserva_id,
                'mesa', p_numero_mesa,
                'error', 'WHATSAPP_SEND_ERROR',
                'http_status', v_http_response.status,
                'response', v_http_response.content
            );
        END IF;

    EXCEPTION WHEN OTHERS THEN
        -- Capturar erros na chamada HTTP
        RAISE WARNING '❌ Exceção ao chamar Edge Function: % - %', SQLERRM, SQLSTATE;
        
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Mesa atribuída, mas houve exceção ao tentar enviar mensagem',
            'reserva_id', p_reserva_id,
            'mesa', p_numero_mesa,
            'error', 'EDGE_FUNCTION_EXCEPTION',
            'error_message', SQLERRM,
            'error_state', SQLSTATE
        );
    END;

END;
$$;


ALTER FUNCTION "public"."atribuir_mesa_e_notificar_cliente"("p_reserva_id" bigint, "p_numero_mesa" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."atribuir_mesa_e_notificar_cliente"("p_reserva_id" bigint, "p_numero_mesa" "text") IS 'Atribui uma mesa a uma reserva e notifica o cliente via WhatsApp através da Edge Function send_whats_wame.';



CREATE OR REPLACE FUNCTION "public"."atualizar_limite_periodo"("p_empresa_id" bigint, "p_nome_periodo" "text", "p_limite_maximo" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_empresa_existe BOOLEAN;
    v_regras_existem BOOLEAN;
    v_json_atual JSONB;
    v_json_atualizado JSONB;
    v_elemento JSONB;
    v_encontrou BOOLEAN := FALSE;
BEGIN
    RAISE WARNING '🚀 [INÍCIO] atualizar_limite_periodo';
    RAISE WARNING '📥 [INPUT] Empresa: %, Período: "%", Limite Máximo: %', 
        p_empresa_id, p_nome_periodo, p_limite_maximo;

    -- ========== VALIDAÇÃO 1: EMPRESA EXISTE? ==========
    SELECT EXISTS(
        SELECT 1 FROM public.empresa 
        WHERE id = p_empresa_id
    ) INTO v_empresa_existe;

    IF NOT v_empresa_existe THEN
        RAISE WARNING '❌ [VALIDAÇÃO] Empresa ID % não encontrada', p_empresa_id;
        RETURN jsonb_build_object(
            'success', false,
            'error', format('Empresa com ID %s não encontrada no sistema.', p_empresa_id)
        );
    END IF;

    RAISE WARNING '✅ [VALIDAÇÃO] Empresa existe';

    -- ========== VALIDAÇÃO 2: LIMITE MÁXIMO ==========
    IF p_limite_maximo < 1 THEN
        RAISE WARNING '❌ [VALIDAÇÃO] Limite máximo inválido: %', p_limite_maximo;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'O limite máximo deve ser maior ou igual a 1.'
        );
    END IF;

    -- ========== VALIDAÇÃO 3: NOME DO PERÍODO ==========
    IF TRIM(p_nome_periodo) = '' THEN
        RAISE WARNING '❌ [VALIDAÇÃO] Nome do período vazio';
        RETURN jsonb_build_object(
            'success', false,
            'error', 'O nome do período não pode estar vazio.'
        );
    END IF;

    RAISE WARNING '✅ [VALIDAÇÃO] Parâmetros válidos';

    -- ========== VERIFICAR SE EXISTE REGISTRO DE REGRAS ==========
    SELECT EXISTS(
        SELECT 1 FROM public.regras_de_reserva 
        WHERE empresa_id = p_empresa_id
    ) INTO v_regras_existem;

    IF NOT v_regras_existem THEN
        -- ========== CASO 1: NÃO EXISTE - CRIAR NOVO ==========
        RAISE WARNING '➕ [CASO 1] Nenhuma regra existe. Criando novo registro...';
        
        INSERT INTO public.regras_de_reserva (
            empresa_id,
            limites_por_periodo
        ) VALUES (
            p_empresa_id,
            jsonb_build_array(
                jsonb_build_object(
                    'nome_periodo', p_nome_periodo,
                    'limite_convidados', p_limite_maximo
                )
            )
        );

        RAISE WARNING '✅ [CASO 1] Registro criado com sucesso';
        
        RETURN jsonb_build_object(
            'success', true,
            'action', 'created',
            'message', format('Regras criadas para o período "%s" com limite de %s pessoas', 
                p_nome_periodo, p_limite_maximo),
            'data', jsonb_build_object(
                'empresa_id', p_empresa_id,
                'nome_periodo', p_nome_periodo,
                'limite_convidados', p_limite_maximo
            )
        );
    END IF;

    -- ========== CASO 2: EXISTE - ATUALIZAR ==========
    RAISE WARNING '🔄 [CASO 2] Regras existem. Atualizando...';

    -- Busca o JSON atual
    SELECT limites_por_periodo INTO v_json_atual
    FROM public.regras_de_reserva
    WHERE empresa_id = p_empresa_id;

    RAISE WARNING '📊 [CASO 2] JSON atual: %', v_json_atual;

    -- Se o JSON for NULL, inicializa como array vazio
    IF v_json_atual IS NULL THEN
        v_json_atual := '[]'::jsonb;
        RAISE WARNING '⚠️ [CASO 2] JSON era NULL, inicializado como []';
    END IF;

    -- ========== PROCESSA O JSON - UPSERT NO ARRAY ==========
    v_json_atualizado := '[]'::jsonb;
    v_encontrou := FALSE;

    RAISE WARNING '🔍 [CASO 2] Procurando período "%s" no array...', p_nome_periodo;

    -- Loop por todos os elementos do array
    FOR v_elemento IN SELECT * FROM jsonb_array_elements(v_json_atual)
    LOOP
        IF (v_elemento->>'nome_periodo') = p_nome_periodo THEN
            -- Encontrou! Atualiza este elemento
            v_encontrou := TRUE;
            
            RAISE WARNING '🎯 [CASO 2] Período encontrado! Atualizando...';
            RAISE WARNING '   Valor antigo: %', v_elemento->>'limite_convidados';
            RAISE WARNING '   Valor novo: %', p_limite_maximo;
            
            -- Adiciona o elemento atualizado
            v_json_atualizado := v_json_atualizado || jsonb_build_array(
                jsonb_build_object(
                    'nome_periodo', p_nome_periodo,
                    'limite_convidados', p_limite_maximo
                )
            );
        ELSE
            -- Não é o período buscado, mantém como está
            v_json_atualizado := v_json_atualizado || jsonb_build_array(v_elemento);
        END IF;
    END LOOP;

    -- Se não encontrou, adiciona como novo
    IF NOT v_encontrou THEN
        RAISE WARNING '➕ [CASO 2] Período não encontrado no array. Adicionando...';
        
        v_json_atualizado := v_json_atualizado || jsonb_build_array(
            jsonb_build_object(
                'nome_periodo', p_nome_periodo,
                'limite_convidados', p_limite_maximo
            )
        );
    END IF;

    RAISE WARNING '📊 [CASO 2] JSON atualizado: %', v_json_atualizado;

    -- ========== ATUALIZA NO BANCO ==========
    UPDATE public.regras_de_reserva
    SET limites_por_periodo = v_json_atualizado
    WHERE empresa_id = p_empresa_id;

    RAISE WARNING '✅ [CASO 2] Atualização concluída com sucesso';

    -- ========== RETORNO DE SUCESSO ==========
    RETURN jsonb_build_object(
        'success', true,
        'action', CASE WHEN v_encontrou THEN 'updated' ELSE 'inserted' END,
        'message', CASE 
            WHEN v_encontrou THEN format('Período "%s" atualizado para %s pessoas', p_nome_periodo, p_limite_maximo)
            ELSE format('Período "%s" adicionado com limite de %s pessoas', p_nome_periodo, p_limite_maximo)
        END,
        'data', jsonb_build_object(
            'empresa_id', p_empresa_id,
            'nome_periodo', p_nome_periodo,
            'limite_convidados', p_limite_maximo,
            'todos_periodos', v_json_atualizado
        )
    );

EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE WARNING '🔥 [ERRO] Violação de chave estrangeira';
        RETURN jsonb_build_object(
            'success', false,
            'error', format('Empresa com ID %s não existe no sistema.', p_empresa_id)
        );
    WHEN OTHERS THEN
        RAISE WARNING '🔥 [ERRO] %', SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM
        );
END;
$$;


ALTER FUNCTION "public"."atualizar_limite_periodo"("p_empresa_id" bigint, "p_nome_periodo" "text", "p_limite_maximo" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."atualizar_limite_periodo"("p_empresa_id" bigint, "p_nome_periodo" "text", "p_limite_maximo" integer) IS 'Insere ou atualiza (UPSERT) o limite máximo de capacidade de um período específico.
Versão simplificada - apenas 3 parâmetros: empresa_id, nome_periodo, limite_maximo.';



CREATE OR REPLACE FUNCTION "public"."atualizar_prompt_completo"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$BEGIN
    -- *** LÓGICA CORRIGIDA AQUI ***
    -- Concatena todas as partes na ordem correta e sem cabeçalhos.
    -- O resultado é guardado na coluna 'prompt'.
    NEW.prompt := 
        COALESCE(NEW.instrucao_inicial, '') || E'\n\n' ||
        COALESCE(NEW.eventos, '') || E'\n\n' ||
        COALESCE(NEW.instrucao_de_funcionamento, '') || E'\n\n' ||
        COALESCE(NEW.funcionamento, '') || E'\n\n' ||
        COALESCE(NEW.datas_especiais, '') || E'\n\n' ||
        COALESCE(NEW.prompt_base, '');

    -- Retorna a linha modificada para ser salva no banco de dados.
    RETURN NEW;
END;$$;


ALTER FUNCTION "public"."atualizar_prompt_completo"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."atualizar_prompts_de_funcionamento"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_empresa_id BIGINT;
    v_funcionamento_semanal TEXT;
    v_datas_especiais_xml TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN v_empresa_id := OLD.empresa_id;
    ELSE v_empresa_id := NEW.empresa_id; END IF;

    -- Lógica para dias normais
    WITH dias_agrupados AS (SELECT dia_semana, format(E'## **%s:**\n\n%s', CASE dia_semana WHEN 1 THEN 'Domingo' WHEN 2 THEN 'Segunda-feira' WHEN 3 THEN 'Terça-feira' WHEN 4 THEN 'Quarta-feira' WHEN 5 THEN 'Quinta-feira' WHEN 6 THEN 'Sexta-feira' WHEN 7 THEN 'Sábado' END, string_agg(format(E'###%s:\n\n###Horário:    %s às %s\n###Promoção: %s\n###Atração: %s\n###Cardápio: %s', p.nome_periodo, to_char(p.horario_inicio, 'HH24:MI'), to_char(p.horario_fim, 'HH24:MI'), COALESCE(p.promocao, 'Não informado'), COALESCE(p.atracao, 'Não informado'), COALESCE(p.cardapio, 'Não informado')), E'\n\n' ORDER BY p.horario_inicio)) as bloco_diario FROM public.periodos_funcionamento p WHERE p.empresa_id = v_empresa_id AND p.ativo = true AND p.data_especial = false GROUP BY dia_semana)
    SELECT string_agg(bloco_diario, E'\n\n' ORDER BY dia_semana) INTO v_funcionamento_semanal FROM dias_agrupados;
    
    -- Lógica para datas especiais
    SELECT '<datasEspeciais>' || COALESCE(string_agg(format('<evento data="%s"><titulo>%s</titulo><descricao>Horário: %s às %s. Atração: %s. Promoção: %s. Cardápio: %s.</descricao></evento>', to_char(p.data_evento_especial, 'TMDay DD/MM/YYYY'), p.nome_periodo, to_char(p.horario_inicio, 'HH24:MI'), to_char(p.horario_fim, 'HH24:MI'), COALESCE(p.atracao, 'Não informado'), COALESCE(p.promocao, 'Não informado'), COALESCE(p.cardapio, 'Não informado')), '' ORDER BY p.data_evento_especial), '<evento>Nenhuma data especial programada.</evento>') || '</datasEspeciais>'
    INTO v_datas_especiais_xml
    FROM public.periodos_funcionamento p
    WHERE p.empresa_id = v_empresa_id AND p.ativo = true AND p.data_especial = true AND p.data_evento_especial >= CURRENT_DATE;

    -- *** ALTERAÇÃO APLICADA AQUI ***
    -- A atualização agora é direcionada para o prompt do tipo 'principal'.
    UPDATE public.prompt
    SET 
        funcionamento = COALESCE(v_funcionamento_semanal, 'Nenhum horário de funcionamento cadastrado.'),
        datas_especiais = COALESCE(v_datas_especiais_xml, '<datasEspeciais><evento>Nenhuma data especial programada.</evento></datasEspeciais>')
    WHERE empresa = v_empresa_id AND tipo_prompt = 'principal';

    RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."atualizar_prompts_de_funcionamento"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."atualizar_tools_no_prompt"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_prompt_id BIGINT;
    v_tools_array JSONB[]; -- A variável agora corresponde ao tipo da coluna
BEGIN
    -- Identifica o prompt afetado pela alteração na ferramenta.
    IF TG_OP = 'DELETE' THEN
        v_prompt_id := OLD.prompt_id;
    ELSE
        v_prompt_id := NEW.prompt_id;
    END IF;

    -- Se a ferramenta não estiver ligada a nenhum prompt, não há nada a fazer.
    IF v_prompt_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- *** CORREÇÃO APLICADA AQUI ***
    -- Usa array_agg para criar um array nativo do PostgreSQL do tipo jsonb[],
    -- que corresponde ao tipo da sua coluna 'tools'.
    SELECT
        array_agg(f.function) -- 'function' é a sua coluna com a definição JSONB.
    INTO v_tools_array
    FROM public.functions f
    WHERE f.prompt_id = v_prompt_id;

    -- Atualiza a coluna 'tools' na tabela de prompt com o novo array.
    -- O COALESCE agora usa '{}'::jsonb[], que é um array vazio do tipo correto.
    UPDATE public.prompt
    SET tools = COALESCE(v_tools_array, '{}'::jsonb[])
    WHERE id = v_prompt_id;

    RETURN NULL; -- O resultado de um trigger AFTER não importa.
END;
$$;


ALTER FUNCTION "public"."atualizar_tools_no_prompt"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."block_self_role_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- Verifica se a operação é um UPDATE e se a coluna 'role' foi alterada.
    IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role THEN
        -- Se o cargo foi alterado, verificamos se o usuário que está a fazer a ação
        -- tem permissão para isso (nível 'gerente' ou superior), usando a função corrigida.
        IF NOT public.usuario_tem_permissao_de('gerente') THEN
            RAISE EXCEPTION 'Permissão negada: Você não tem autorização para alterar cargos.';
        END IF;
    END IF;

    -- Permite que a operação continue.
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."block_self_role_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bloqueio_ia_cliente"("p_cliente_id" bigint, "p_suspender_permanentemente" boolean DEFAULT false, "p_reativar" boolean DEFAULT false) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_cliente_encontrado BOOLEAN;
BEGIN
    -- --- ALTERAÇÃO AQUI: PASSO DE VALIDAÇÃO ---
    -- 1. Verifica se o cliente com o ID fornecido realmente existe.
    SELECT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id) INTO v_cliente_encontrado;
    
    -- Se o cliente não for encontrado, para a execução e retorna um erro.
    IF NOT v_cliente_encontrado THEN
        RETURN 'Erro: Cliente com ID ' || p_cliente_id || ' não foi encontrado.';
    END IF;

    -- O resto da lógica só é executado se o cliente existir.

    -- CASO 1: Reativar a IA.
    IF p_reativar = TRUE THEN
        UPDATE public.clientes
        SET
            ia_suspended = FALSE,
            ia_muted_until = NULL,
            atendido_por = NULL -- Também libera o chat de qualquer operador
        WHERE id = p_cliente_id;

        RETURN 'IA reativada para o cliente ' || p_cliente_id;

    -- CASO 2: Suspender a IA permanentemente.
    ELSIF p_suspender_permanentemente = TRUE THEN
        UPDATE public.clientes
        SET
            ia_suspended = TRUE,
            ia_muted_until = NULL, -- Limpa qualquer mute temporário conflitante
            atendido_por = auth.uid() -- Associa o operador que suspendeu ao atendimento
        WHERE id = p_cliente_id;

        RETURN 'IA suspensa permanentemente para o cliente ' || p_cliente_id;

    -- CASO 3: Silenciar a IA temporariamente (o padrão, se nenhuma outra flag for true).
    ELSE
        UPDATE public.clientes
        SET
            ia_muted_until = NOW() + INTERVAL '15 minutes'
        WHERE id = p_cliente_id;

        RETURN 'IA silenciada por 15 minutos para o cliente ' || p_cliente_id;
    END IF;

EXCEPTION
    WHEN others THEN
        RAISE WARNING 'Erro ao gerenciar estado da IA para o cliente %: %', p_cliente_id, SQLERRM;
        RETURN 'Erro: ' || SQLERRM;
END;
$$;


ALTER FUNCTION "public"."bloqueio_ia_cliente"("p_cliente_id" bigint, "p_suspender_permanentemente" boolean, "p_reativar" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."buscar_contrato"("p_telefone" "text") RETURNS json
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN (
    SELECT json_build_object(
      'found', true,
      'contrato', row_to_json(c)
    )
    FROM contratos c
    WHERE c.telefone = p_telefone
    ORDER BY c.created_at DESC
    LIMIT 1
  );
  
  -- Se não encontrou
  IF NOT FOUND THEN
    RETURN json_build_object(
      'found', false,
      'message', 'Nenhum contrato encontrado para este telefone'
    );
  END IF;
END;
$$;


ALTER FUNCTION "public"."buscar_contrato"("p_telefone" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."buscar_reserva_ativa_cliente"("p_cliente_uuid" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_cliente_id BIGINT;
    v_reserva_ativa RECORD;
BEGIN
    -- Passo 1: Busca o ID interno do cliente a partir do UUID fornecido.
    RAISE WARNING '[DIAGNÓSTICO] Iniciando busca para cliente com UUID: %', p_cliente_uuid;
    SELECT id INTO v_cliente_id
    FROM public.clientes 
    WHERE uuid_identificador = p_cliente_uuid;

    -- Se o cliente não for encontrado, retorna que não há reserva.
    IF NOT FOUND THEN
        RAISE WARNING '[DIAGNÓSTICO] FALHA: Cliente com UUID % NÃO foi encontrado na tabela clientes.', p_cliente_uuid;
        RETURN jsonb_build_object('reserva_encontrada', false);
    END IF;

    RAISE WARNING '[DIAGNÓSTICO] SUCESSO: Cliente encontrado. ID interno: %', v_cliente_id;

    -- Passo 2: Com o ID do cliente, busca a próxima reserva ativa.
    RAISE WARNING '[DIAGNÓSTICO] Buscando reserva ativa para cliente ID %...', v_cliente_id;
    SELECT * INTO v_reserva_ativa
    FROM public.reservas
    WHERE clientes_id = v_cliente_id
      AND data_reserva >= CURRENT_DATE
      AND cancelada_cliente = false
      AND cancelada_casa = false
    ORDER BY data_reserva ASC, created_at DESC
    LIMIT 1;

    -- Passo 3: Retorna o resultado com base na busca.
    IF FOUND THEN
        -- Se encontrou uma reserva, retorna os detalhes dela.
        RAISE WARNING '[DIAGNÓSTICO] SUCESSO: Reserva ativa (ID: %) encontrada para a data %.', v_reserva_ativa.id, v_reserva_ativa.data_reserva;
        RETURN jsonb_build_object(
            'reserva_encontrada', true,
            'reserva', row_to_json(v_reserva_ativa)
        );
    ELSE
        -- Se não encontrou, retorna a indicação para criar uma nova.
        RAISE WARNING '[DIAGNÓSTICO] AVISO: Nenhuma reserva ativa encontrada para o cliente ID % que cumpra os critérios (futura e não cancelada).', v_cliente_id;
        RETURN jsonb_build_object('reserva_encontrada', false);
    END IF;

END;
$$;


ALTER FUNCTION "public"."buscar_reserva_ativa_cliente"("p_cliente_uuid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."chamar_update_event_prompt"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_empresa_id BIGINT;
    v_xml_agenda_string TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN v_empresa_id := OLD.empresa_id;
    ELSE v_empresa_id := NEW.empresa_id; END IF;

    DELETE FROM public.eventos WHERE empresa_id = v_empresa_id AND data_evento < CURRENT_DATE;

    SELECT '<agendaSemanal>' || COALESCE(string_agg(format('<evento data="%s"><atracao>%s</atracao><sobre_o_evento>%s</sobre_o_evento></evento>', (CASE WHEN to_char(e.data_evento, 'D') = '1' THEN 'Domingo' WHEN to_char(e.data_evento, 'D') = '2' THEN 'Segunda-feira' WHEN to_char(e.data_evento, 'D') = '3' THEN 'Terça-feira' WHEN to_char(e.data_evento, 'D') = '4' THEN 'Quarta-feira' WHEN to_char(e.data_evento, 'D') = '5' THEN 'Quinta-feira' WHEN to_char(e.data_evento, 'D') = '6' THEN 'Sexta-feira' WHEN to_char(e.data_evento, 'D') = '7' THEN 'Sábado' END || to_char(e.data_evento, ' DD/MM/YYYY')), e.titulo, COALESCE(e.descricao, 'Nenhuma informação adicional.')), '' ORDER BY e.data_evento), '<evento>Nenhum evento especial programado para os próximos dias.</evento>') || '</agendaSemanal>'
    INTO v_xml_agenda_string
    FROM public.eventos e
    WHERE e.empresa_id = v_empresa_id AND e.data_evento >= CURRENT_DATE;

    -- *** ALTERAÇÃO APLICADA AQUI ***
    -- A atualização agora é direcionada para o prompt do tipo 'principal'.
    UPDATE public.prompt
    SET eventos = v_xml_agenda_string
    WHERE empresa = v_empresa_id AND tipo_prompt = 'principal';

    RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."chamar_update_event_prompt"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirmar_reserva"("p_reserva_id" bigint, "p_cancelar" boolean DEFAULT false) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_reserva RECORD;
    v_regulamento TEXT;
    v_mensagem_cliente TEXT;
    v_http_response JSONB;
    -- *** COMENTÁRIO: Chave da API WAAPI aqui ***
    -- Cole a sua chave da waapi.app no lugar de 'SEU_WAAPI_TOKEN_AQUI'
    v_waapi_token TEXT := 'SEU_WAAPI_TOKEN_AQUI'; 
BEGIN
    RAISE WARNING '[DIAGNÓSTICO] Iniciando função confirmar_reserva para reserva_id: %, cancelar: %', p_reserva_id, p_cancelar;

    -- 1. Verifica a permissão do utilizador logado
    IF NOT public.usuario_tem_permissao_de('portaria') THEN
        RAISE EXCEPTION 'Permissão negada.';
    END IF;

    -- 2. Busca os dados da reserva
    SELECT * INTO v_reserva FROM public.reservas WHERE id = p_reserva_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reserva com ID % não encontrada.', p_reserva_id;
    END IF;
    RAISE WARNING '[DIAGNÓSTICO] Reserva encontrada. Estado de edição: %', v_reserva.editar;

    -- 3. Lógica de Ação e Construção da Mensagem
    IF p_cancelar = TRUE THEN
        -- FLUXO DE CANCELAMENTO / RECUSA PELA CASA
        RAISE WARNING '[DIAGNÓSTICO] Entrando no fluxo de CANCELAMENTO/RECUSA.';
        IF v_reserva.editar = TRUE THEN
            -- Ação: Recusar uma edição. Limpa os campos de edição.
            UPDATE public.reservas
            SET editar = false, novo_nome = NULL, novo_adultos = NULL, novo_crianca = NULL, nova_observacao = NULL
            WHERE id = p_reserva_id;
            
            v_mensagem_cliente := '⚠️ *Atenção sobre sua Reserva* ⚠️' || E'\n\n' ||
                                  'Olá, ' || v_reserva.nome || '. Recebemos sua solicitação de alteração.' || E'\n\n' ||
                                  'Infelizmente, devido à nossa lotação, *não conseguimos adicionar os lugares extra* que você pediu.' || E'\n\n' ||
                                  'Mas não se preocupe! Sua reserva original, para ' || v_reserva.adultos || ' adultos e ' || COALESCE(v_reserva.criancas, 0) || ' crianças, *continua confirmada*!' || E'\n\n' ||
                                  'Agradecemos a sua compreensão e aguardamos vocês!';
        ELSE
            -- Ação: Cancelar uma nova reserva.
            UPDATE public.reservas SET cancelada_casa = true WHERE id = p_reserva_id;

            v_mensagem_cliente := '🚫 *Reserva Não Confirmada* 🚫' || E'\n\n' ||
                                  'Olá, ' || v_reserva.nome || '. Agradecemos o seu contato!' || E'\n\n' ||
                                  'Infelizmente, atingimos nossa capacidade máxima de reservas para a data solicitada. O atendimento agora será realizado *somente por ordem de chegada*.' || E'\n\n' ||
                                  'Agradecemos a sua compreensão e esperamos vê-lo(a) em breve!';
        END IF;
    ELSE
        -- FLUXO DE CONFIRMAÇÃO PELA CASA
        RAISE WARNING '[DIAGNÓSTICO] Entrando no fluxo de CONFIRMAÇÃO.';
        BEGIN
            SELECT prompt_texto INTO v_regulamento
            FROM public.prompt_reserva
            WHERE empresa_id = v_reserva.empresa_id;
        EXCEPTION
            WHEN others THEN v_regulamento := 'Consulte as regras da casa no local.';
        END;

        IF v_reserva.editar = TRUE THEN
            -- Ação: Aprovar uma edição. Copia os novos dados e limpa os campos de edição.
            UPDATE public.reservas
            SET 
                nome = COALESCE(novo_nome, nome),
                adultos = COALESCE(novo_adultos, adultos),
                criancas = COALESCE(novo_crianca, criancas),
                observacoes = COALESCE(nova_observacao, observacoes),
                editar = false,
                confirmada = true,
                novo_nome = NULL,
                novo_adultos = NULL,
                novo_crianca = NULL,
                nova_observacao = NULL
            WHERE id = p_reserva_id;

            v_mensagem_cliente := '🔄 *Sua Reserva foi Atualizada!* 🔄' || E'\n\n' ||
                                  'Olá, ' || COALESCE(v_reserva.novo_nome, v_reserva.nome) || '!' || E'\n' ||
                                  'Sua solicitação de alteração foi aprovada com sucesso.' || E'\n\n' ||
                                  '*Novos Detalhes da Reserva:*' || E'\n' ||
                                  '-----------------' || E'\n' ||
                                  '📅 *Data:* ' || to_char(v_reserva.data_reserva, 'DD/MM/YYYY') || E'\n' ||
                                  '👤 *Convidados:* ' || COALESCE(v_reserva.novo_adultos, v_reserva.adultos) || ' adultos e ' || COALESCE(v_reserva.novo_crianca, v_reserva.criancas, 0) || ' crianças' || E'\n' ||
                                  '📝 *Observações:* ' || COALESCE(v_reserva.nova_observacao, v_reserva.observacoes, 'Nenhuma') || E'\n' ||
                                  '-----------------' || E'\n\n' ||
                                  '_Atenção: Por favor, desconsidere qualquer confirmação anterior._' ||
                                  E'\n\n' || COALESCE(v_regulamento, ''); 
        ELSE
            -- Ação: Confirmar uma nova reserva.
            UPDATE public.reservas SET confirmada = true WHERE id = p_reserva_id;

            v_mensagem_cliente := '🎉 *Reserva Confirmada!* 🎉' || E'\n\n' ||
                                  'Olá, ' || v_reserva.nome || '!' || E'\n' ||
                                  'Sua reserva foi confirmada com sucesso. Estamos ansiosos para recebê-lo(a)!' || E'\n\n' ||
                                  '*Resumo da sua Reserva:*' || E'\n' ||
                                  '-----------------' || E'\n' ||
                                  '📅 *Data:* ' || to_char(v_reserva.data_reserva, 'DD/MM/YYYY') || E'\n' ||
                                  '👤 *Convidados:* ' || v_reserva.adultos || ' adultos e ' || COALESCE(v_reserva.criancas, 0) || ' crianças' || E'\n' ||
                                  '📝 *Observações:* ' || COALESCE(v_reserva.observacoes, 'Nenhuma') || E'\n' ||
                                  '-----------------' ||
                                  E'\n\n' || COALESCE(v_regulamento, '');
        END IF;
    END IF;

    -- 4. Valida se os dados de contato existem antes de enviar
    IF v_reserva.chat_id IS NULL OR v_reserva.instancia IS NULL THEN
        RAISE WARNING '[DIAGNÓSTICO] Ação no banco de dados concluída, mas a notificação foi pulada por falta de chat_id ou instancia.';
        RETURN 'Ação concluída, mas o cliente não foi notificado por falta de dados.';
    END IF;

    -- 5. Envia a mensagem construída diretamente para a API
    RAISE WARNING '[DIAGNÓSTICO] Enviando mensagem para o cliente...';
    SELECT * INTO v_http_response
    FROM net.http_post(
        url := 'https://waapi.app/api/v1/instances/' || v_reserva.instancia || '/client/action/send-message',
        headers := jsonb_build_object(
            'Accept', 'application/json',
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || '6kURwK0ywBRkUzYGxg07b2oSljzvpV3nClV6kFCeef6a4d58'
        ),
        body := jsonb_build_object(
            'chatId', v_reserva.chat_id,
            'message', v_mensagem_cliente
        ),
        timeout_milliseconds := 15000
    );

    RAISE WARNING '[DIAGNÓSTICO] Resposta da WAAPI: %', v_http_response;

    RETURN 'Ação concluída e notificação enviada. Resposta da API: ' || v_http_response::text;

EXCEPTION
    WHEN others THEN
        RAISE EXCEPTION 'Erro inesperado na função confirmar_reserva: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."confirmar_reserva"("p_reserva_id" bigint, "p_cancelar" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."criar_pastas_de_empresa"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Insere um objeto "placeholder" para criar a pasta de usuários.
  -- O caminho é: /<id_da_empresa>/users/.placeholder
  -- O '.placeholder' é um ficheiro vazio que força a criação da estrutura de pastas.
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES ('users', NEW.id || '/users/.placeholder', auth.uid(), '{}');

  -- Insere um objeto "placeholder" para criar a pasta de mídias.
  -- O caminho é: /<id_da_empresa>/midias/.placeholder
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES ('users', NEW.id || '/midias/.placeholder', auth.uid(), '{}');

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."criar_pastas_de_empresa"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enviar_cliente_xano"("p_cliente_id" bigint) RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$declare
    v_url      text := 'https://x5ii-4wuf-1p2t.n7c.xano.io/api:mg0JJpwR/supabase';
    v_payload  text;          -- corpo JSON em texto
    v_status   int;           -- status HTTP
    v_reply    text;          -- corpo devolvido pelo Xano
begin
    ------------------------------------------------------------------
    -- 1. Gera o JSON do cliente
    ------------------------------------------------------------------
    select row_to_json(c.*)::text
    into   v_payload
    from   public.clientes c
    where  c.id = p_cliente_id;

    if v_payload is null then
        return format('Cliente %s não encontrado.', p_cliente_id);
    end if;

    ------------------------------------------------------------------
    -- 2. Envia POST usando o wrapper http()
    ------------------------------------------------------------------
    select h.status, h.content
    into   v_status, v_reply
    from   http( (
             'POST',
             v_url,
             ARRAY[ http_header('Content-Type','application/json') ],
             'application/json',
             v_payload
           )::http_request ) as h;

    ------------------------------------------------------------------
    -- 3. Devolve resultado legível
    ------------------------------------------------------------------
    return format('HTTP %s | resposta: %s',
                  coalesce(v_status,0),
                  coalesce(v_reply,'<sem corpo>'));
exception
    when others then
        return 'Erro: ' || sqlerrm;
end;$$;


ALTER FUNCTION "public"."enviar_cliente_xano"("p_cliente_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enviar_lembrete_confirmacao"("p_tipo_lembrete" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    reserva_para_lembrar RECORD;
    mensagem_para_cliente TEXT;
BEGIN
    -- Itera sobre todas as reservas que precisam de um lembrete hoje.
    FOR reserva_para_lembrar IN
        SELECT r.id, r.nome, r.clientes_id, c.nome as nome_cliente
        FROM public.reservas r
        JOIN public.clientes c ON r.clientes_id = c.id
        WHERE r.data_reserva = CURRENT_DATE
          AND r.confirmada = true
          AND r.confirmada_dia_reserva = false
          AND r.created_at::date < CURRENT_DATE
          AND r.empresa_id = 3 -- <<< CONDIÇÃO TEMPORÁRIA PARA TESTES
    LOOP
        -- Constrói a mensagem com base no tipo de lembrete
        IF p_tipo_lembrete = 'manha' THEN
            mensagem_para_cliente := 'Olá, ' || COALESCE(reserva_para_lembrar.nome_cliente, reserva_para_lembrar.nome) || '! 👋 Tudo certo para a sua reserva hoje? Por favor, clique no botão "Confirmar Presença" abaixo para garantir o seu lugar. Estamos ansiosos para recebê-lo(a)! 😊';
        
        ELSIF p_tipo_lembrete = 'tarde' THEN
            mensagem_para_cliente := '⚠️ Lembrete sobre sua reserva para hoje, ' || COALESCE(reserva_para_lembrar.nome_cliente, reserva_para_lembrar.nome) || '! Ainda não recebemos sua confirmação. Por favor, clique no botão "Confirmar Presença" para não perder a sua mesa.';

        ELSIF p_tipo_lembrete = 'ultimato' THEN
            mensagem_para_cliente := '❗ ÚLTIMO AVISO ❗ Olá, ' || COALESCE(reserva_para_lembrar.nome_cliente, reserva_para_lembrar.nome) || '. Sua reserva para hoje ainda não foi confirmada. Para evitar o cancelamento, por favor, clique em "Confirmar Presença" agora. Sujeito à disponibilidade da casa.';
        
        END IF;

        -- Envia a notificação usando o gateway
        -- O PERFORM é usado porque não precisamos do resultado da chamada aqui.
        PERFORM net.http_post(
            url := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/send-whatsapp-gateway',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
            ),
            body := jsonb_build_object(
                'cliente_id', reserva_para_lembrar.clientes_id,
                'message', mensagem_para_cliente
            )
        );

        RAISE WARNING 'Lembrete do tipo "%" enviado para a reserva ID %.', p_tipo_lembrete, reserva_para_lembrar.id;

    END LOOP;
END;
$$;


ALTER FUNCTION "public"."enviar_lembrete_confirmacao"("p_tipo_lembrete" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."gerenciar_confirmacao_reserva"("p_reserva_id" bigint, "p_confirmada" boolean, "p_ressalva" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_reserva RECORD; -- Variável para armazenar os dados da reserva encontrada
    v_mensagem_cliente TEXT; -- Variável para construir a mensagem para o cliente
    v_system_message JSONB; -- Variável para a mensagem do sistema a ser salva no histórico
    
    -- --- SUBSTITUA AQUI ---
    -- Cole o ID do seu projeto no lugar de <SEU-ID-DE-PROJETO>
    v_supabase_url TEXT := 'https://ctsvfluufyfhkqlonqio.supabase.co';
    
    -- --- SUBSTITUA AQUI ---
    -- Cole sua chave SERVICE_ROLE completa no lugar de <SUA-CHAVE-SERVICE-ROLE>
    v_service_role_key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c';
BEGIN
    -- 1. Busca a reserva pelo ID fornecido
    SELECT * INTO v_reserva FROM public.reservas WHERE id = p_reserva_id;

    -- Verifica se a reserva foi encontrada
    IF NOT FOUND THEN
        RETURN 'Erro: Reserva não encontrada.';
    END IF;

    -- 2. Lógica principal baseada no status de edição da reserva
    IF v_reserva.editar = FALSE THEN
        -- CASO A: É uma NOVA reserva (não está em modo de edição)
        IF p_confirmada = TRUE THEN
            -- Ação: Confirma a nova reserva
            UPDATE public.reservas SET confirmada = TRUE WHERE id = p_reserva_id;

            -- Mensagem para o cliente
            v_mensagem_cliente := 'Ótima notícia, ' || v_reserva.nome || '! 🎉 Sua reserva para a data ' || to_char(v_reserva.data_reserva, 'DD/MM/YYYY') || ' foi CONFIRMADA. Estamos te esperando!';

        ELSE
            -- Ação: Recusa (cancela pela casa) a nova reserva
            UPDATE public.reservas SET cancelada_casa = TRUE WHERE id = p_reserva_id;

            -- Mensagem para o cliente
            v_mensagem_cliente := 'Olá, ' || v_reserva.nome || '. Gostaríamos de informar que, infelizmente, não temos disponibilidade para sua solicitação de reserva para a data ' || to_char(v_reserva.data_reserva, 'DD/MM/YYYY') || '.';
            IF p_ressalva IS NOT NULL AND p_ressalva <> '' THEN
                v_mensagem_cliente := v_mensagem_cliente || ' Motivo: ' || p_ressalva;
            END IF;
        END IF;

    ELSE
        -- CASO B: É uma EDIÇÃO de reserva
        IF p_confirmada = TRUE THEN
            -- Ação: Aprova a edição, atualiza os campos e guarda o histórico da alteração.
            UPDATE public.reservas
            SET 
                nome = COALESCE(v_reserva.novo_nome, v_reserva.nome),
                adultos = COALESCE(v_reserva.novo_adultos, v_reserva.adultos),
                criancas = COALESCE(v_reserva.novo_crianca, v_reserva.criancas),
                observacoes = COALESCE(v_reserva.nova_observacao, v_reserva.observacoes),
                horario = COALESCE(v_reserva.novo_horario, v_reserva.horario),
                novo_nome = CASE WHEN v_reserva.novo_nome IS NOT NULL THEN v_reserva.nome ELSE NULL END,
                novo_adultos = CASE WHEN v_reserva.novo_adultos IS NOT NULL THEN v_reserva.adultos ELSE NULL END,
                novo_crianca = CASE WHEN v_reserva.novo_crianca IS NOT NULL THEN v_reserva.criancas ELSE NULL END,
                nova_observacao = CASE WHEN v_reserva.nova_observacao IS NOT NULL THEN v_reserva.observacoes ELSE NULL END,
                novo_horario = CASE WHEN v_reserva.novo_horario IS NOT NULL THEN v_reserva.horario ELSE NULL END,
                editar = FALSE,
                confirmada = TRUE
            WHERE id = p_reserva_id;
            
            -- Mensagem para o cliente
            v_mensagem_cliente := 'Boas notícias, ' || v_reserva.nome || '! ✅ Sua solicitação de alteração para a reserva do dia ' || to_char(v_reserva.data_reserva, 'DD/MM/YYYY') || ' foi APROVADA com sucesso.';

        ELSE
            -- Ação: Recusa a edição. A reserva original é mantida.
            UPDATE public.reservas
            SET 
                novo_nome = NULL,
                novo_adultos = NULL,
                novo_crianca = NULL,
                nova_observacao = NULL,
                novo_horario = NULL,
                editar = FALSE
            WHERE id = p_reserva_id;
            
            -- Mensagem para o cliente
            v_mensagem_cliente := 'Olá, ' || v_reserva.nome || '. Infelizmente, não conseguimos atender à sua solicitação de alteração. Mas não se preocupe, sua reserva original para ' || v_reserva.adultos || ' adultos no dia ' || to_char(v_reserva.data_reserva, 'DD/MM/YYYY') || ' continua confirmada!';
            IF p_ressalva IS NOT NULL AND p_ressalva <> '' THEN
                v_mensagem_cliente := v_mensagem_cliente || ' Motivo: ' || p_ressalva;
            END IF;
        END IF;
    END IF;

    -- --- ADICIONADO AQUI ---
    -- 3. Atualiza o histórico da conversa com a ação tomada
    v_system_message := jsonb_build_object('role', 'system', 'content', v_mensagem_cliente);
    PERFORM public.append_to_compelition_chat(v_reserva.clientes_id, v_system_message);


    -- 4. Invoca a Edge Function para enviar a mensagem via WhatsApp
    PERFORM net.http_post(
        url:= v_supabase_url || '/functions/v1/send-whatsapp-message',
        headers:= jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_role_key
        ),
        body:= jsonb_build_object(
            'chatId', v_reserva.chat_id,
            'instancia', v_reserva.instancia,
            'message', v_mensagem_cliente
        )
    );

    RETURN 'Ação de confirmação/recusa executada e notificação enviada.';

EXCEPTION
    WHEN others THEN
        RAISE WARNING 'Erro inesperado na função gerenciar_confirmacao_reserva: %', SQLERRM;
        RETURN 'Erro: ' || SQLERRM;

END;
$$;


ALTER FUNCTION "public"."gerenciar_confirmacao_reserva"("p_reserva_id" bigint, "p_confirmada" boolean, "p_ressalva" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_chat_history"("p_chat_id" "text", "p_instancia" "text") RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
SELECT
  -- COALESCE garante que, se não houver mensagens, a função retorne
  -- um array vazio '[]' em vez de NULL, o que é mais seguro.
  COALESCE(
    -- jsonb_agg agrega todas as linhas resultantes em um único array JSON.
    jsonb_agg(
      -- jsonb_build_object cria um objeto para cada mensagem.
      jsonb_build_object(
        'mensagem', cz.mensagem,
        'enviado_pelo_operador', cz.enviado_pelo_operador,
        'timestamp', cz."tsData" -- Usamos aspas duplas para o nome com letra maiúscula
      )
      -- Ordena as mensagens pela data, da mais antiga para a mais nova.
      ORDER BY cz."tsData" ASC
    ),
    '[]'::jsonb
  )
FROM
  public."chatsZap" AS cz -- Usamos aspas duplas para o nome da tabela com letra maiúscula
WHERE
  cz."chatId" = p_chat_id
  AND cz.instancia = p_instancia;
$$;


ALTER FUNCTION "public"."get_chat_history"("p_chat_id" "text", "p_instancia" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_chat_list"("p_empresa_id" bigint, "p_page_size" integer DEFAULT 20, "p_page_number" integer DEFAULT 1) RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
SELECT
  -- COALESCE garante que, se não houver resultados, a função retorne um array vazio '[]'
  -- em vez de NULL, o que é mais seguro para o front-end.
  COALESCE(
    -- jsonb_agg agrega todas as linhas resultantes em um único array JSON.
    jsonb_agg(
      to_jsonb(sub) -- Converte cada linha da nossa subquery em um objeto JSON
    ),
    '[]'::jsonb
  )
FROM (
    -- Esta é a query principal que busca os dados
    SELECT
        c.id,
        c.nome,
        c."chatId",
        c.modifyed_at AS ultima_atividade,
        -- Esta subquery busca o conteúdo da última mensagem para exibir na lista de chats.
        (
            SELECT cz.mensagem
            FROM public."chatsZap" cz
            WHERE cz."chatId" = c."chatId"
            ORDER BY cz.created_at DESC
            LIMIT 1
        ) as ultima_mensagem
    FROM
        public.clientes c
    WHERE
        -- Filtra para trazer apenas clientes da empresa do funcionário logado
        c.empresa_id = p_empresa_id
        -- A cláusula EXISTS é a forma mais performática de verificar se um cliente
        -- tem pelo menos um registro correspondente na tabela 'chatsZap'.
        AND EXISTS (
            SELECT 1
            FROM public."chatsZap" cz
            WHERE cz."chatId" = c."chatId"
        )
    -- Ordena a lista para que os chats com atividade mais recente apareçam no topo.
    ORDER BY
        c.modifyed_at DESC
    -- Lógica de paginação para o scroll infinito
    LIMIT p_page_size
    OFFSET (p_page_number - 1) * p_page_size

) AS sub;
$$;


ALTER FUNCTION "public"."get_chat_list"("p_empresa_id" bigint, "p_page_size" integer, "p_page_number" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_company_settings"() RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
  -- A query usa uma sub-query para primeiro encontrar o 'empresa_id' do usuário logado
  -- na tabela 'profiles', e então usa esse ID para buscar os dados da empresa correta.
  SELECT to_jsonb(e.*)
  FROM public.empresa e
  WHERE e.id = (
    SELECT p.empresa_id
    FROM public.profiles p
    WHERE p.id = auth.uid()::text -- Converte o UUID do auth para TEXT para corresponder ao ID do Clerk
  );
$$;


ALTER FUNCTION "public"."get_company_settings"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_confirmation_context"("p_empresa_id" bigint, "p_data" "date") RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$

WITH reservas_do_dia AS (
  SELECT *
  FROM public.reservas r
  WHERE
    r.empresa_id = p_empresa_id
    AND r.data_reserva = p_data
    -- Ignoramos as reservas que já foram canceladas
    AND r.cancelada_cliente = FALSE
    AND r.cancelada_casa = FALSE
)
SELECT jsonb_build_object(
    'contexto_dia', (
        -- Subquery para calcular as estatísticas do dia
        SELECT jsonb_build_object(
            'data', p_data,
            'reservas_confirmadas', COUNT(*) FILTER (WHERE confirmada = TRUE),
            'convidados_confirmados', COALESCE(SUM(adultos + criancas) FILTER (WHERE confirmada = TRUE), 0)::bigint,
            'reservas_pendentes', COUNT(*) FILTER (WHERE confirmada = FALSE),
            'convidados_pendentes', COALESCE(SUM(adultos + criancas) FILTER (WHERE confirmada = FALSE), 0)::bigint
        )
        FROM reservas_do_dia
    ),
    'reservas_pendentes', (
        -- Subquery para criar a lista de reservas que precisam de ação
        SELECT COALESCE(
            jsonb_agg(
                to_jsonb(rd)
                -- Ordena a lista para que as reservas maiores apareçam primeiro
                ORDER BY (rd.adultos + COALESCE(rd.criancas, 0)) DESC
            ) FILTER (WHERE rd.confirmada = FALSE), 
            '[]'::jsonb -- Retorna um array vazio se não houver reservas pendentes
        )
        FROM reservas_do_dia rd
    )
);

$$;


ALTER FUNCTION "public"."get_confirmation_context"("p_empresa_id" bigint, "p_data" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_dashboard_analytics"() RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_empresa_id BIGINT;
    v_start_of_week DATE;
    v_start_of_month DATE;
BEGIN
    -- Busca a empresa do usuário logado
    SELECT empresa_id INTO v_empresa_id
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_empresa_id IS NULL THEN
        RAISE EXCEPTION 'Perfil não encontrado ou sem empresa associada.';
    END IF;

    -- Define o início da semana atual (Domingo) e do mês atual
    v_start_of_week := date_trunc('week', CURRENT_DATE);
    v_start_of_month := date_trunc('month', CURRENT_DATE);

    -- Constrói o objeto JSON final com todas as métricas necessárias
    RETURN jsonb_build_object(
        'dia_anterior', (
            SELECT to_jsonb(dm) FROM public.daily_metrics_by_company dm
            WHERE dm.empresa_id = v_empresa_id AND dm.metrica_dia = (CURRENT_DATE - INTERVAL '1 day')
        ),
        'semana_atual', (
            SELECT jsonb_agg(to_jsonb(dm) ORDER BY dm.metrica_dia) FROM public.daily_metrics_by_company dm
            WHERE dm.empresa_id = v_empresa_id AND dm.metrica_dia >= v_start_of_week AND dm.metrica_dia < CURRENT_DATE
        ),
        'mes_atual', (
            SELECT jsonb_agg(to_jsonb(dm) ORDER BY dm.metrica_dia) FROM public.daily_metrics_by_company dm
            WHERE dm.empresa_id = v_empresa_id AND dm.metrica_dia >= v_start_of_month AND dm.metrica_dia < CURRENT_DATE
        ),
        'ultimos_12_meses', (
            SELECT jsonb_agg(monthly_data)
            FROM (
                SELECT
                    to_char(dm.metrica_dia, 'YYYY-MM') AS mes,
                    SUM(dm.total_reservas) AS total_reservas,
                    SUM(dm.total_convidados) AS total_convidados,
                    SUM(dm.total_conversas) AS total_conversas
                FROM public.daily_metrics_by_company dm
                WHERE dm.empresa_id = v_empresa_id AND dm.metrica_dia >= (CURRENT_DATE - INTERVAL '12 months')
                GROUP BY to_char(dm.metrica_dia, 'YYYY-MM')
                ORDER BY mes
            ) AS monthly_data
        )
    );
END;
$$;


ALTER FUNCTION "public"."get_dashboard_analytics"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_equipa_da_empresa"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_manager_empresa_id BIGINT;
BEGIN
    -- PASSO 1: Obter o ID da empresa do gerente que está a fazer a chamada.
    SELECT empresa_id
    INTO v_manager_empresa_id
    FROM public.profiles
    WHERE id = auth.uid();

    -- Se o utilizador não for encontrado ou não pertencer a uma empresa, retorna uma lista vazia.
    IF v_manager_empresa_id IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    -- PASSO 2: Retornar a lista de todos os perfis daquela empresa.
    RETURN (
        SELECT COALESCE(
            jsonb_agg(
                -- Selecionamos as colunas que queremos expor na API.
                jsonb_build_object(
                    'id', p.id,
                    'empresa_id', p.empresa_id, -- <<< CAMPO ADICIONADO AQUI
                    'nome', p.nome,
                    'email', p.email,
                    'role', p.role,
                    'foto_url', p.foto_url,
                    'ddd', p.ddd,
                    'telefone', p.telefone,
                    'ativo', p.ativo,
                    'cadastro_concluido', p.cadastro_concluido
                )
                ORDER BY p.nome
            ),
            '[]'::jsonb -- Retorna um array JSON vazio se não houver resultados.
        )
        FROM public.profiles p
        WHERE p.empresa_id = v_manager_empresa_id
    );
END;
$$;


ALTER FUNCTION "public"."get_equipa_da_empresa"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_empresa_id"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN (
    SELECT empresa_id FROM public.profiles WHERE id = auth.uid()
  );
END;
$$;


ALTER FUNCTION "public"."get_my_empresa_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_profile"() RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Retorna o primeiro perfil encontrado que corresponde ao ID do usuário autenticado.
    -- O resultado é convertido para o formato JSONB.
    RETURN (
        SELECT to_jsonb(p)
        FROM public.profiles p
        WHERE p.id = auth.uid()
        LIMIT 1
    );
END;
$$;


ALTER FUNCTION "public"."get_my_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_role"() RETURNS "public"."app_role"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN (
    SELECT role FROM public.profiles WHERE id = auth.uid()
  );
END;
$$;


ALTER FUNCTION "public"."get_my_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pending_confirmations"("p_empresa_id" bigint) RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
SELECT
  -- COALESCE garante que, se não houver nenhuma reserva pendente, a função retorne um array vazio '[]'
  -- em vez de NULL, o que é mais seguro para o front-end.
  COALESCE(
    jsonb_agg(
      to_jsonb(r) -- Converte cada linha da reserva (r) em um objeto JSON
      -- Ordena os resultados pelo total de convidados (adultos + crianças) em ordem decrescente,
      -- ANTES de os agregar no array final.
      ORDER BY (r.adultos + COALESCE(r.criancas, 0)) DESC
    ),
    '[]'::jsonb
  )
FROM
  public.reservas r
WHERE
  r.empresa_id = p_empresa_id
  AND r.data_reserva >= CURRENT_DATE -- Considera apenas de hoje em diante
  -- A definição de "pendente" é: não está confirmada E não foi cancelada.
  AND r.confirmada = FALSE
  AND r.cancelada_cliente = FALSE
  AND r.cancelada_casa = FALSE;
$$;


ALTER FUNCTION "public"."get_pending_confirmations"("p_empresa_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_reservations_for_day"("p_empresa_id" bigint, "p_data" "date") RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
WITH reservas_do_dia AS (
  SELECT *
  FROM public.reservas r
  WHERE
    r.empresa_id = p_empresa_id
    AND r.data_reserva = p_data
    AND r.confirmada = TRUE
    AND r.cancelada_cliente = FALSE
    AND r.cancelada_casa = FALSE
)
SELECT jsonb_build_object(
    'data', p_data,
    'reservas', (
        SELECT COALESCE(jsonb_agg(to_jsonb(rd) ORDER BY rd.id), '[]'::jsonb)
        FROM reservas_do_dia rd
    ),
    'total_criancas', (
        SELECT COALESCE(SUM(rd.criancas), 0)::bigint
        FROM reservas_do_dia rd
    ),
    'total_adultos', (
        SELECT COALESCE(SUM(rd.adultos), 0)::bigint
        FROM reservas_do_dia rd
    )
);
$$;


ALTER FUNCTION "public"."get_reservations_for_day"("p_empresa_id" bigint, "p_data" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_reservations_for_day"("p_empresa_id" bigint, "p_data" "date") IS 'Retorna, em JSON, todas as reservas CONFIRMADAS de uma empresa para a data informada, 
incluindo a soma de crianças e adultos.';



CREATE OR REPLACE FUNCTION "public"."get_reservations_summary"("p_empresa_id" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_resumo jsonb;
BEGIN
    /*
      A query interna agora filtra apenas por reservas que estão confirmadas
      e que não foram canceladas, garantindo uma contagem precisa da ocupação.
    */
    SELECT 
        -- COALESCE garante que, se não houver nenhuma reserva, a função retorne um array vazio '[]'
        -- em vez de NULL, o que é mais seguro para o front-end.
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'data', to_char(sub.data_reserva, 'DD/MM/YYYY'), -- Formata a data para exibição
                    'total_reservas', sub.total_reservas,
                    'total_convidados', sub.total_convidados
                )
                ORDER BY sub.data_reserva ASC -- Ordena o resultado por data
            ),
            '[]'::jsonb
        )
    INTO v_resumo
    FROM (
        -- Subquery que faz a agregação dos dados
        SELECT
            r.data_reserva,
            COUNT(*) AS total_reservas,
            SUM(r.adultos + COALESCE(r.criancas, 0))::bigint AS total_convidados
        FROM
            public.reservas r
        WHERE
            -- --- FILTROS ADICIONADOS ---
            r.empresa_id = p_empresa_id      -- Filtra pela empresa
            AND r.confirmada = TRUE          -- Apenas reservas confirmadas
            AND r.cancelada_cliente = FALSE  -- E que não foram canceladas pelo cliente
            AND r.cancelada_casa = FALSE     -- E que não foram canceladas pela casa
            AND r.data_reserva >= CURRENT_DATE -- Apenas para hoje e datas futuras
        GROUP BY
            r.data_reserva
    ) AS sub;

    -- Retorna um objeto JSON final para a API
    RETURN jsonb_build_object(
        'empresa_id', p_empresa_id,
        'dias', v_resumo
    );
END;
$$;


ALTER FUNCTION "public"."get_reservations_summary"("p_empresa_id" bigint) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_reservations_summary"("p_empresa_id" bigint) IS 'Devolve, em JSON, o resumo diário (total de crianças e adultos) das reservas da empresa informada.';



CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_empresa_id_convite BIGINT;
BEGIN
    -- Pega a empresa_id que foi "anexada" ao convite a partir dos metadados do utilizador.
    -- O operador '->>' extrai o valor do JSON como texto, e o '::bigint' converte para número.
    -- Usamos COALESCE para evitar erros se o campo não existir (ex: signup normal).
    v_empresa_id_convite := (NEW.raw_user_meta_data ->> 'empresa_id')::bigint;

    -- Insere o novo perfil com o ID, o Email e a Empresa do convite (se houver).
    INSERT INTO public.profiles (id, email, empresa_id)
    VALUES (NEW.id, NEW.email, v_empresa_id_convite);
  
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."limpeza_diaria_sistema"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_compelitions_apagados INT;
    v_chatszap_apagados INT;
BEGIN
    RAISE LOG '[LIMPEZA DIÁRIA] Iniciando processo de limpeza...';

    -- 1. Apaga registros antigos da tabela chatsZap (mais de 7 dias)
    WITH deleted AS (
        DELETE FROM public.chatsZap
        WHERE "tsData" < NOW() - INTERVAL '7 days'
        RETURNING *
    )
    SELECT count(*) INTO v_chatszap_apagados FROM deleted;

    RAISE LOG '[LIMPEZA DIÁRIA] ... % registros apagados da tabela chatsZap.', v_chatszap_apagados;

    -- 2. Apaga compelitions antigos (mais de 7 dias) DE CLIENTES SEM RESERVA ATIVA
    WITH deleted AS (
        DELETE FROM public.compelition c
        WHERE 
            -- A conversa é mais antiga que 7 dias
            c."modificadoEm" < NOW() - INTERVAL '7 days'
            -- E o cliente associado NÃO está na lista de clientes com reservas futuras
            AND c.cliente NOT IN (
                SELECT DISTINCT r.clientes_id
                FROM public.reservas r
                WHERE r.data_reserva >= CURRENT_DATE
                  AND r.cancelada_cliente = false
                  AND r.cancelada_casa = false
                  AND r.clientes_id IS NOT NULL
            )
        RETURNING *
    )
    SELECT count(*) INTO v_compelitions_apagados FROM deleted;

    RAISE LOG '[LIMPEZA DIÁRIA] ... % conversas (compelitions) de clientes inativos foram apagadas.', v_compelitions_apagados;
    RAISE LOG '[LIMPEZA DIÁRIA] Processo de limpeza concluído.';

END;
$$;


ALTER FUNCTION "public"."limpeza_diaria_sistema"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."marcar_reserva_como_confirmada"("p_cliente_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Atualiza a reserva mais recente do cliente para o dia de hoje,
    -- marcando-a como confirmada pelo cliente.
    UPDATE public.reservas
    SET confirmada_dia_reserva = true
    WHERE id = (
        SELECT id
        FROM public.reservas
        WHERE clientes_id = p_cliente_id
          AND data_reserva = CURRENT_DATE
          AND cancelada_cliente = false
          AND cancelada_casa = false
        ORDER BY created_at DESC
        LIMIT 1
    );
END;
$$;


ALTER FUNCTION "public"."marcar_reserva_como_confirmada"("p_cliente_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."nome_da_sua_funcao"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Só executa a lógica se a operação for um UPDATE.
    IF TG_OP = 'UPDATE' THEN
        -- Verifica se as colunas protegidas 'empresa_id' ou 'instancia' foram alteradas.
        -- "IS DISTINCT FROM" lida corretamente com valores nulos.
        IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR
           NEW.instancia IS DISTINCT FROM OLD.instancia
           -- A verificação do "chatId" foi REMOVIDA daqui.
        THEN
            -- Se uma coluna protegida foi alterada, verifica se o usuário tem o nível 'dev'.
            -- Apenas um 'dev' pode fazer este tipo de alteração crítica.
            IF NOT public.usuario_tem_permissao_de('dev') THEN
                -- Atualiza a mensagem de erro para refletir as colunas que ainda estão protegidas.
                RAISE EXCEPTION 'Permissão negada: As colunas empresa_id e instancia não podem ser alteradas.';
            END IF;
        END IF;
    END IF;

    -- Se todas as verificações passarem (ou se apenas o chatId foi alterado), 
    -- permite que o UPDATE continue.
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."nome_da_sua_funcao"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."processar_cliente_especifico"("p_cliente_id" integer) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    retorno_http TEXT;
    status_code INT;
BEGIN
    -- 1. GARANTE QUE O JOB NÃO SE REPETIRÁ
    -- Remove o próprio agendamento da fila do cron para que ele execute apenas uma vez.
    PERFORM cron.unschedule('processar-cliente-' || p_cliente_id);

    -- 2. Envia os dados do cliente para a API externa (Xano)
    SELECT public.enviar_cliente_xano(p_cliente_id)
    INTO   retorno_http;

    -- 3. Extrai o status code da resposta HTTP
    SELECT substring(retorno_http FROM 'HTTP[[:space:]]+([0-9]+)')::INT
    INTO   status_code;

    -- 4. SUCESSO TOTAL: Verifica se o status retornado é exatamente 200
    IF status_code = 200 THEN
        -- Limpa a mensagem e desativa o agendamento, pois temos certeza que o Xano processou.
        UPDATE public.clientes
        SET    "mensagemAgregada" = '',
               agendado           = FALSE,
               modifyed_at        = NOW()
        WHERE  id = p_cliente_id;

        RAISE LOG '✅ Sucesso (200 OK)! Cliente % processado. Mensagem e agendamento limpos.', p_cliente_id;
        RETURN 'Sucesso';
    ELSE
        -- 5. FALHA NO PROCESSAMENTO: Status diferente de 200 ou erro.
        -- "Destrava" o cliente (agendado=FALSE) mas MANTÉM a mensagem para não perdê-la.
        UPDATE public.clientes
        SET    agendado    = FALSE,
               modifyed_at = NOW()
        WHERE  id = p_cliente_id;

        RAISE WARNING '⚠️ Falha no processamento do cliente % (Retorno: %). O agendamento foi desfeito, mas a mensagem foi mantida para a próxima tentativa.', p_cliente_id, retorno_http;
        RETURN 'Falha';
    END IF;

EXCEPTION
    -- Captura qualquer erro inesperado durante a execução (ex: Xano fora do ar)
    WHEN others THEN
        -- Garante que o agendamento seja cancelado mesmo em caso de erro.
        PERFORM cron.unschedule('processar-cliente-' || p_cliente_id);
        
        -- Aplica a mesma lógica de falha: destrava o cliente, mas mantém a mensagem.
        UPDATE public.clientes
        SET    agendado    = FALSE,
               modifyed_at = NOW()
        WHERE  id = p_cliente_id;
        
        RAISE WARNING '⛔ Erro inesperado ao processar cliente %: %', p_cliente_id, SQLERRM;
        RETURN 'Erro';
END;
$$;


ALTER FUNCTION "public"."processar_cliente_especifico"("p_cliente_id" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."processar_clientes_agendados"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$DECLARE
    cliente_rec RECORD; -- Renomeado para clareza
    retorno_http TEXT;
    status_code INT;
    cliente_id_local INT; -- Variável para armazenar o ID
BEGIN
    ------------------------------------------------------------------
    -- 1. Seleciona todos os clientes com agendado = true
    ------------------------------------------------------------------
    FOR cliente_rec IN
        SELECT id
        FROM   public.clientes
        WHERE  agendado = TRUE
    LOOP
        -- Armazena o ID do cliente atual em uma variável local
        cliente_id_local := cliente_rec.id;

        ----------------------------------------------------------------
        -- 2. Envia os dados do cliente para a API externa (Xano)
        ----------------------------------------------------------------
        SELECT public.enviar_cliente_xano(cliente_id_local)
        INTO   retorno_http;

        ----------------------------------------------------------------
        -- 3. Extrai o status code da resposta HTTP
        ----------------------------------------------------------------
        SELECT substring(retorno_http FROM 'HTTP[[:space:]]+([0-9]+)')::INT
        INTO   status_code;

        ----------------------------------------------------------------
        -- 4. Verifica se a requisição foi bem-sucedida (status 2xx)
        ----------------------------------------------------------------
        IF status_code BETWEEN 200 AND 299 THEN
            ------------------------------------------------------------
            -- 5. Sucesso: Limpa a mensagem e desativa o agendamento
            --    Usa a variável local na cláusula WHERE para garantir a atualização
            ------------------------------------------------------------
            UPDATE public.clientes
            SET    "mensagemAgregada" = '',
                   agendado           = FALSE,
                   modifyed_at        = NOW()
            WHERE  id = cliente_id_local; -- Correção aqui

            RAISE LOG '✅ Cliente % processado com sucesso (HTTP %).', cliente_id_local, status_code;
        ELSE
            ------------------------------------------------------------
            -- 6. Falha: Registra um aviso para análise
            ------------------------------------------------------------
            RAISE WARNING '⚠️ Falha ao enviar cliente % (Retorno: %). Tente novamente.',
                          cliente_id_local, retorno_http;
        END IF;
    END LOOP;
END;$$;


ALTER FUNCTION "public"."processar_clientes_agendados"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."processar_e_arquivar_mensagem"("p_cliente_id" bigint) RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_compelition_id        BIGINT;
    v_novo_objeto_msg       JSONB;
    v_empresa_id            BIGINT;
    v_data_atual_formatada  TEXT;
    v_dia_semana            TEXT;
    v_mensagem_agregada     TEXT;
    v_modo_ia               public.modo_ia_type;
BEGIN
    -- 1) Preparação (inalterada)
    PERFORM cron.unschedule('processar-cliente-' || p_cliente_id);

    SELECT "mensagemAgregada", empresa_id
      INTO v_mensagem_agregada, v_empresa_id
    FROM public.clientes
    WHERE id = p_cliente_id;

    IF v_empresa_id IS NULL THEN
        RETURN 'Erro: Empresa não encontrada.';
    END IF;

    IF v_mensagem_agregada IS NULL OR trim(v_mensagem_agregada) = '' THEN
        UPDATE public.clientes
           SET agendado = FALSE,
               modifyed_at = NOW()
         WHERE id = p_cliente_id;
        RETURN 'Mensagem vazia';
    END IF;

    -- Formata data/hora local para embutir no turno user
    v_dia_semana := CASE to_char(NOW() AT TIME ZONE 'America/Sao_Paulo', 'D')
                        WHEN '1' THEN 'Domingo'
                        WHEN '2' THEN 'Segunda-feira'
                        WHEN '3' THEN 'Terça-feira'
                        WHEN '4' THEN 'Quarta-feira'
                        WHEN '5' THEN 'Quinta-feira'
                        WHEN '6' THEN 'Sexta-feira'
                        WHEN '7' THEN 'Sábado'
                    END;

    v_data_atual_formatada := v_dia_semana || ', ' ||
                              to_char(NOW() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI');

    -- Monta objeto da última mensagem (role=user) para persistir no compelition.chat
    v_novo_objeto_msg := jsonb_build_object(
        'role',    'user',
        'content', '<data>' || v_data_atual_formatada || '</data> ' || v_mensagem_agregada
    );

    -- Upsert do compelition (chat só com turns de usuário)
    SELECT id
      INTO v_compelition_id
    FROM public.compelition
    WHERE cliente = p_cliente_id
      AND empresa = v_empresa_id
    LIMIT 1;

    IF v_compelition_id IS NOT NULL THEN
        UPDATE public.compelition
           SET chat = COALESCE(chat, '[]'::jsonb) || v_novo_objeto_msg,
               "modificadoEm" = NOW()
         WHERE id = v_compelition_id;
    ELSE
        INSERT INTO public.compelition (cliente, empresa, chat)
        VALUES (p_cliente_id, v_empresa_id, jsonb_build_array(v_novo_objeto_msg))
        RETURNING id INTO v_compelition_id;
    END IF;

    -- 2) Busca o modo de IA da empresa
    SELECT modo_ia
      INTO v_modo_ia
    FROM public.empresa
    WHERE id = v_empresa_id;

    -- 3) Decide qual orquestrador chamar
    CASE v_modo_ia
        WHEN 'conversation' THEN
            -- ALTERAÇÃO: além do cliente_id, enviar também compelition_id
            RAISE WARNING '🚀 Acionando ORQUESTRADOR CONVERSATION (Responses API) p/ empresa %, cliente %, compelition %...',
                          v_empresa_id, p_cliente_id, v_compelition_id;

            PERFORM net.http_post(
                url     := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/orquestrador-conversation',
                headers := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
                           ),
                body    := jsonb_build_object(
                              'cliente_id',      p_cliente_id,
                              'compelition_id',  v_compelition_id   -- << novo campo
                           )
            );

        WHEN 'roteador_de_agentes' THEN
            RAISE WARNING '🚀 Acionando o NOVO AGENTE ROTEADOR p/ empresa %...', v_empresa_id;
            PERFORM net.http_post(
                url     := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/agente-roteador',
                headers := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
                           ),
                body    := jsonb_build_object(
                              'compelition_id', v_compelition_id
                           )
            );

        WHEN 'roteador_com_variaveis' THEN
            RAISE WARNING '🚀 Acionando o ROTEADOR COM VARIÁVEIS p/ empresa %...', v_empresa_id;
            PERFORM net.http_post(
                url     := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/orquestrador-com-link-dinamico',
                headers := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
                           ),
                body    := jsonb_build_object(
                              'compelition_id', v_compelition_id
                           )
            );

        ELSE  -- 'prompt_unico' (legado de produção)
            RAISE WARNING '🚀 Acionando o orquestrador de PRODUÇÃO (gemini-compelition) p/ empresa %...', v_empresa_id;
            PERFORM net.http_post(
                url     := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/gemini-compelition',
                headers := jsonb_build_object(
                              'Content-Type',  'application/json',
                              'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
                           ),
                body    := jsonb_build_object(
                              'compelition_id', v_compelition_id
                           )
            );
    END CASE;

    -- 4) Limpa dados temporários (inalterado)
    UPDATE public.clientes
       SET "mensagemAgregada" = '',
           agendado          = FALSE,
           modifyed_at       = NOW()
     WHERE id = p_cliente_id;

    RETURN 'Sucesso';

EXCEPTION
    WHEN OTHERS THEN
        PERFORM cron.unschedule('processar-cliente-' || p_cliente_id);
        UPDATE public.clientes
           SET agendado = FALSE,
               modifyed_at = NOW()
         WHERE id = p_cliente_id;
        RAISE WARNING '⛔ Erro inesperado em processar_e_arquivar_mensagem para cliente ID %: %',
                      p_cliente_id, SQLERRM;
        RETURN 'Erro';
END;
$$;


ALTER FUNCTION "public"."processar_e_arquivar_mensagem"("p_cliente_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."processar_e_arquivar_teste_espelho"("p_compelition_id_producao" bigint, "p_mensagem_agregada" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_chat_teste_atual JSONB;
    v_novo_objeto_msg JSONB;
BEGIN
    RAISE WARNING '⏯️ [ESPELHO PASSO 1/5] Função de teste iniciada para o compelition de produção ID: %', p_compelition_id_producao;

    -- Busca o histórico de teste atual da conversa de produção.
    SELECT chat_teste INTO v_chat_teste_atual
    FROM public.compelition
    WHERE id = p_compelition_id_producao;
    RAISE WARNING '⏯️ [ESPELHO PASSO 2/5] Histórico de teste buscado com sucesso.';

    -- Cria o objeto da nova mensagem do usuário.
    v_novo_objeto_msg := jsonb_build_object('role', 'user', 'content', p_mensagem_agregada);
    RAISE WARNING '⏯️ [ESPELHO PASSO 3/5] Objeto de nova mensagem criado.';

    -- Anexa a nova mensagem ao histórico de teste.
    UPDATE public.compelition
    SET chat_teste = COALESCE(v_chat_teste_atual, '[]'::jsonb) || v_novo_objeto_msg
    WHERE id = p_compelition_id_producao;
    RAISE WARNING '⏯️ [ESPELHO PASSO 4/5] Histórico de teste (coluna chat_teste) atualizado no banco de dados.';
    
    -- Aciona o NOVO agente roteador, passando o ID da conversa.
    RAISE WARNING '⏯️ [ESPELHO PASSO 5/5] 🚀 Acionando o agente-roteador...';
    
    -- *** CORREÇÃO APLICADA AQUI ***
    -- A chamada agora inclui o cabeçalho 'Authorization' com a sua chave de serviço.
    PERFORM net.http_post(
        url:= 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/agente-roteador',
        headers:= jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
        ),
        body:= jsonb_build_object('compelition_id', p_compelition_id_producao)
    );
    
    RAISE WARNING '✅ [ESPELHO] Chamada para o agente-roteador disparada com sucesso.';

EXCEPTION
    WHEN others THEN
        RAISE WARNING '🔥 [ESPELHO] Erro inesperado na função de teste espelho: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."processar_e_arquivar_teste_espelho"("p_compelition_id_producao" bigint, "p_mensagem_agregada" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promover_usuario"("p_alvo_id" "uuid", "p_novo_cargo" "public"."app_role") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_ator_id uuid := auth.uid();
    v_ator_role public.app_role;
    v_ator_empresa_id bigint;
    v_alvo_role_atual public.app_role;
    v_alvo_empresa_id bigint;
BEGIN
    -- PASSO 1: Obter as informações do ator (quem está a fazer a ação)
    SELECT role, empresa_id
    INTO v_ator_role, v_ator_empresa_id
    FROM public.profiles
    WHERE id = v_ator_id;

    -- PASSO 2: Obter as informações do alvo (quem está a ser promovido)
    SELECT role, empresa_id
    INTO v_alvo_role_atual, v_alvo_empresa_id
    FROM public.profiles
    WHERE id = p_alvo_id;

    -- Validação: Garante que o alvo existe
    IF v_alvo_role_atual IS NULL THEN
        RAISE EXCEPTION 'Usuário alvo não encontrado.';
    END IF;
    
    -- Validação: Garante que a ação ocorre dentro da mesma empresa
    IF v_ator_empresa_id IS DISTINCT FROM v_alvo_empresa_id THEN
        RAISE EXCEPTION 'Ação não permitida: os usuários pertencem a empresas diferentes.';
    END IF;

    -- REGRA DE NEGÓCIO 1: Ninguém pode promover a si mesmo.
    IF v_ator_id = p_alvo_id THEN
        RAISE EXCEPTION 'Permissão negada: Você não pode alterar o seu próprio cargo através desta função.';
    END IF;

    -- REGRA DE NEGÓCIO 2: O cargo 'dev' é sagrado e não pode ser atribuído.
    IF p_novo_cargo = 'dev' THEN
        RAISE EXCEPTION 'Permissão negada: O cargo "dev" não pode ser atribuído.';
    END IF;

    -- REGRA DE NEGÓCIO 3: Hierarquia para o 'gerente'
    IF v_ator_role = 'gerente' THEN
        -- Um gerente só pode promover para cargos que estão estritamente abaixo dele.
        IF p_novo_cargo IN ('metre', 'portaria', 'garcon') THEN
            -- Permite a ação
            NULL; 
        ELSE
            RAISE EXCEPTION 'Permissão negada: Um gerente só pode atribuir os cargos de metre, portaria ou garçom.';
        END IF;
    
    -- REGRA DE NEGÓCIO 4: Hierarquia para 'proprietario' (e cargos superiores como 'adm' e 'dev')
    ELSIF v_ator_role IN ('proprietario', 'adm', 'dev') THEN
        -- Um proprietário pode promover para qualquer cargo, exceto um igual ou superior ao seu.
        IF (v_ator_role = 'proprietario' AND p_novo_cargo IN ('proprietario', 'adm', 'dev')) THEN
             RAISE EXCEPTION 'Permissão negada: Um proprietário não pode criar outros proprietários ou administradores.';
        END IF;
        -- Se a verificação passar, permite a ação
        NULL;

    ELSE
        -- Se o ator não for nem gerente nem proprietário (ou superior), ele não tem permissão.
        RAISE EXCEPTION 'Permissão negada: Você não tem autorização para promover usuários.';
    END IF;
    
    -- PASSO FINAL: Se todas as regras passaram, executa a atualização.
    UPDATE public.profiles
    SET role = p_novo_cargo
    WHERE id = p_alvo_id;

    RETURN 'Operação de cargo realizada com sucesso!';

END;
$$;


ALTER FUNCTION "public"."promover_usuario"("p_alvo_id" "uuid", "p_novo_cargo" "public"."app_role") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_critical_client_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Só executa a lógica se a operação for um UPDATE.
    IF TG_OP = 'UPDATE' THEN
        -- Verifica se alguma das colunas protegidas foi alterada.
        -- "IS DISTINCT FROM" lida corretamente com valores nulos.
        IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id OR
           NEW.instancia IS DISTINCT FROM OLD.instancia OR
           NEW."chatId" IS DISTINCT FROM OLD."chatId"
        THEN
            -- Se uma coluna protegida foi alterada, verifica se o usuário tem o nível 'dev'.
            -- Apenas um 'dev' pode fazer este tipo de alteração crítica.
            IF NOT public.usuario_tem_permissao_de('dev') THEN
                RAISE EXCEPTION 'Permissão negada: As colunas empresa, instancia e chatId não podem ser alteradas.';
            END IF;
        END IF;
    END IF;

    -- Se todas as verificações passarem, permite que o UPDATE continue.
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_critical_client_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."testar_leitura_secret"("p_secret_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_secret_value text;
BEGIN
    RAISE WARNING '🔎 Tentando ler o secret com o nome: %', p_secret_name;

    -- Tenta ler o valor do secret fornecido.
    -- O 'true' no final significa que a função não dará erro se não encontrar,
    -- apenas retornará NULL, que é o que queremos verificar.
    SELECT current_setting('app.settings.' || p_secret_name, true) INTO v_secret_value;

    -- Verifica o resultado e nos informa.
    IF v_secret_value IS NULL THEN
        RAISE WARNING '❌ FALHA: O secret "%" não foi encontrado na secção "User-defined secrets". Verifique o nome e se ele foi criado corretamente.', p_secret_name;
        RETURN 'FALHA';
    ELSE
        RAISE WARNING '✅ SUCESSO: O secret "%" foi lido com sucesso.', p_secret_name;
        -- Para este teste, vamos mostrar os primeiros caracteres do valor para confirmar.
        RAISE WARNING '🤫 Valor encontrado (início): %', left(v_secret_value, 10);
        RETURN 'SUCESSO';
    END IF;
EXCEPTION
    WHEN others THEN
        RAISE WARNING '⛔ ERRO INESPERADO: Ocorreu um erro na função de teste: %', SQLERRM;
        RETURN 'ERRO';
END;
$$;


ALTER FUNCTION "public"."testar_leitura_secret"("p_secret_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_chamar_teste_responses_api"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Dispara a chamada para a Edge Function de teste em segundo plano,
    -- passando o ID do novo registro 'chatsZap'.
    PERFORM net.http_post(
        url := 'https://ctsvfluufyfhkqlonqio.supabase.co/functions/v1/teste_responses_api',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0c3ZmbHV1ZnlmaGtxbG9ucWlvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0OTA3NDAxNywiZXhwIjoyMDY0NjUwMDE3fQ.MKP2txoJjAYEjXFR-5I7Tv-Sw2ldqP2BZXJFZdPf60c'
        ),
        body := jsonb_build_object('chatszap_id', NEW.id)
    );

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_chamar_teste_responses_api"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_analytics_aggregates"("p_data_referencia" "date" DEFAULT (CURRENT_DATE - '1 day'::interval)) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_inicio_mes date;
    v_fim_mes date;
    v_inicio_ano date;
    v_fim_ano date;
    v_daily_rows_affected INT;
BEGIN
    RAISE WARNING '⚠️ [MÉTRICAS] Iniciando a função update_analytics_aggregates para a data: %', p_data_referencia;

    -- 1. Agregado DIÁRIO para o dia anterior.
    WITH daily_agg AS (
        INSERT INTO public.analytics_aggregates (empresa_id, periodo_tipo, periodo_inicio, nome_agente, total_invocacoes)
        SELECT
            inv.empresa_id,
            'daily',
            p_data_referencia,
            inv.nome_agente,
            COUNT(*)
        FROM public.agent_invocations inv
        WHERE inv.created_at::date = p_data_referencia
        GROUP BY inv.empresa_id, inv.nome_agente
        ON CONFLICT (empresa_id, periodo_tipo, periodo_inicio, nome_agente) DO UPDATE
        SET total_invocacoes = EXCLUDED.total_invocacoes
        RETURNING 1
    )
    SELECT count(*) INTO v_daily_rows_affected FROM daily_agg;
    RAISE WARNING '... [MÉTRICAS DIÁRIAS] % linhas de métricas diárias foram inseridas/atualizadas.', v_daily_rows_affected;


    -- 2. Agregado MENSAL (só executa se o dia for o primeiro do mês)
    IF EXTRACT(DAY FROM p_data_referencia + INTERVAL '1 day') = 1 THEN
        RAISE WARNING '... [MÉTRICAS MENSAIS] Detectado o fim do mês. Iniciando agregação mensal.';
        v_inicio_mes := date_trunc('month', p_data_referencia)::date;
        v_fim_mes := (v_inicio_mes + INTERVAL '1 month' - INTERVAL '1 day')::date;

        INSERT INTO public.analytics_aggregates (empresa_id, periodo_tipo, periodo_inicio, nome_agente, total_invocacoes)
        SELECT
            agg.empresa_id,
            'monthly',
            v_inicio_mes,
            agg.nome_agente,
            SUM(agg.total_invocacoes)
        FROM public.analytics_aggregates agg
        WHERE agg.periodo_tipo = 'daily' AND agg.periodo_inicio BETWEEN v_inicio_mes AND v_fim_mes
        GROUP BY agg.empresa_id, agg.nome_agente
        ON CONFLICT (empresa_id, periodo_tipo, periodo_inicio, nome_agente) DO UPDATE
        SET total_invocacoes = EXCLUDED.total_invocacoes;
        RAISE WARNING '... [MÉTRICAS MENSAIS] Agregação mensal concluída.';
    END IF;

    -- 3. Agregado ANUAL (só executa se o dia for 1 de Janeiro)
    IF EXTRACT(MONTH FROM p_data_referencia + INTERVAL '1 day') = 1 AND EXTRACT(DAY FROM p_data_referencia + INTERVAL '1 day') = 1 THEN
        RAISE WARNING '... [MÉTRICAS ANUAIS] Detectado o fim do ano. Iniciando agregação anual.';
        v_inicio_ano := date_trunc('year', p_data_referencia)::date;
        v_fim_ano := (v_inicio_ano + INTERVAL '1 year' - INTERVAL '1 day')::date;

        INSERT INTO public.analytics_aggregates (empresa_id, periodo_tipo, periodo_inicio, nome_agente, total_invocacoes)
        SELECT
            agg.empresa_id,
            'yearly',
            v_inicio_ano,
            agg.nome_agente,
            SUM(agg.total_invocacoes)
        FROM public.analytics_aggregates agg
        WHERE agg.periodo_tipo = 'monthly' AND agg.periodo_inicio BETWEEN v_inicio_ano AND v_fim_ano
        GROUP BY agg.empresa_id, agg.nome_agente
        ON CONFLICT (empresa_id, periodo_tipo, periodo_inicio, nome_agente) DO UPDATE
        SET total_invocacoes = EXCLUDED.total_invocacoes;
        RAISE WARNING '... [MÉTRICAS ANUAIS] Agregação anual concluída.';
    END IF;
    
    RAISE WARNING '✅ [MÉTRICAS] Função update_analytics_aggregates concluída.';
END;
$$;


ALTER FUNCTION "public"."update_analytics_aggregates"("p_data_referencia" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_contrato"("p_telefone" "text", "p_cliente_id" bigint DEFAULT NULL::bigint, "p_nome" "text" DEFAULT NULL::"text", "p_nome_pai" "text" DEFAULT NULL::"text", "p_nome_mae" "text" DEFAULT NULL::"text", "p_numero_contrato" "text" DEFAULT NULL::"text", "p_banco" "text" DEFAULT NULL::"text", "p_parcelas" integer DEFAULT NULL::integer, "p_valor_parcela" numeric DEFAULT NULL::numeric, "p_prazo_contrato" integer DEFAULT NULL::integer, "p_parcelas_pagas" integer DEFAULT NULL::integer, "p_parcelas_em_aberto" integer DEFAULT NULL::integer, "p_parcelas_atrasadas" integer DEFAULT NULL::integer, "p_valor_estimado_quitacao" numeric DEFAULT NULL::numeric, "p_percentual_desconto" numeric DEFAULT NULL::numeric, "p_status" "text" DEFAULT NULL::"text", "p_observacoes" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_contrato_id UUID;
  v_is_new BOOLEAN := FALSE;
  v_valor_total DECIMAL(12,2);
BEGIN
  
  -- Busca contrato existente pelo telefone
  SELECT id INTO v_contrato_id
  FROM contratos
  WHERE telefone = p_telefone
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- Calcula valor total se tiver parcelas e valor
  IF p_parcelas IS NOT NULL AND p_valor_parcela IS NOT NULL THEN
    v_valor_total := p_parcelas * p_valor_parcela;
  END IF;
  
  -- Se não existe, CRIA novo contrato
  IF v_contrato_id IS NULL THEN
    INSERT INTO contratos (
      telefone,
      cliente_id,
      nome,
      nome_pai,
      nome_mae,
      numero_contrato,
      banco,
      parcelas,
      valor_parcela,
      prazo_contrato,
      parcelas_pagas,
      parcelas_em_aberto,
      parcelas_atrasadas,
      valor_total_contrato,
      valor_estimado_quitacao,
      percentual_desconto,
      status,
      observacoes
    ) VALUES (
      p_telefone,
      p_cliente_id,
      p_nome,
      p_nome_pai,
      p_nome_mae,
      p_numero_contrato,
      p_banco,
      p_parcelas,
      p_valor_parcela,
      p_prazo_contrato,
      p_parcelas_pagas,
      p_parcelas_em_aberto,
      p_parcelas_atrasadas,
      v_valor_total,
      p_valor_estimado_quitacao,
      p_percentual_desconto,
      COALESCE(p_status, 'novo'),
      p_observacoes
    )
    RETURNING id INTO v_contrato_id;
    
    v_is_new := TRUE;
    
  -- Se existe, ATUALIZA só os campos que vieram preenchidos
  ELSE
    UPDATE contratos SET
      cliente_id = COALESCE(p_cliente_id, cliente_id),
      nome = COALESCE(p_nome, nome),
      nome_pai = COALESCE(p_nome_pai, nome_pai),
      nome_mae = COALESCE(p_nome_mae, nome_mae),
      numero_contrato = COALESCE(p_numero_contrato, numero_contrato),
      banco = COALESCE(p_banco, banco),
      parcelas = COALESCE(p_parcelas, parcelas),
      valor_parcela = COALESCE(p_valor_parcela, valor_parcela),
      prazo_contrato = COALESCE(p_prazo_contrato, prazo_contrato),
      parcelas_pagas = COALESCE(p_parcelas_pagas, parcelas_pagas),
      parcelas_em_aberto = COALESCE(p_parcelas_em_aberto, parcelas_em_aberto),
      parcelas_atrasadas = COALESCE(p_parcelas_atrasadas, parcelas_atrasadas),
      valor_total_contrato = COALESCE(v_valor_total, valor_total_contrato),
      valor_estimado_quitacao = COALESCE(p_valor_estimado_quitacao, valor_estimado_quitacao),
      percentual_desconto = COALESCE(p_percentual_desconto, percentual_desconto),
      status = COALESCE(p_status, status),
      observacoes = COALESCE(p_observacoes, observacoes),
      updated_at = now()
    WHERE id = v_contrato_id;
  END IF;
  
  -- Retorna o contrato atualizado
  RETURN (
    SELECT json_build_object(
      'success', true,
      'is_new', v_is_new,
      'contrato_id', v_contrato_id,
      'message', CASE 
        WHEN v_is_new THEN 'Contrato criado com sucesso'
        ELSE 'Contrato atualizado com sucesso'
      END,
      'dados', row_to_json(c)
    )
    FROM contratos c
    WHERE c.id = v_contrato_id
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;


ALTER FUNCTION "public"."upsert_contrato"("p_telefone" "text", "p_cliente_id" bigint, "p_nome" "text", "p_nome_pai" "text", "p_nome_mae" "text", "p_numero_contrato" "text", "p_banco" "text", "p_parcelas" integer, "p_valor_parcela" numeric, "p_prazo_contrato" integer, "p_parcelas_pagas" integer, "p_parcelas_em_aberto" integer, "p_parcelas_atrasadas" integer, "p_valor_estimado_quitacao" numeric, "p_percentual_desconto" numeric, "p_status" "text", "p_observacoes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."usuario_tem_permissao_de"("p_role_requerida" "public"."app_role") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role_do_usuario public.app_role;
BEGIN
  -- Busca a role do usuário que está logado.
  -- CORREÇÃO: Compara 'id' (uuid) com 'auth.uid()' (uuid), sem o '::text'.
  SELECT role INTO v_role_do_usuario FROM public.profiles WHERE id = auth.uid();

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Superusuários podem tudo.
  IF v_role_do_usuario IN ('dev', 'proprietario') THEN
    RETURN TRUE;
  END IF;
  
  -- Lógica de hierarquia
  IF v_role_do_usuario = 'adm' AND p_role_requerida IN ('adm', 'financeiro', 'gerente', 'metre', 'portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'gerente' AND p_role_requerida IN ('gerente', 'metre', 'portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'metre' AND p_role_requerida IN ('metre', 'portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'portaria' AND p_role_requerida IN ('portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'garcon' AND p_role_requerida = 'garcon' THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'financeiro' AND p_role_requerida = 'financeiro' THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;


ALTER FUNCTION "public"."usuario_tem_permissao_de"("p_role_requerida" "public"."app_role") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verificar_disponibilidade"("p_cliente_uuid" "uuid", "p_data_desejada" "date", "p_nome_periodo" "text", "p_numero_de_pessoas" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_cliente_id BIGINT;
    v_empresa_id BIGINT;
    v_regras RECORD;
    v_excecao RECORD;
    v_periodo_funcionamento RECORD;
    v_total_convidados_no_periodo INT;
    v_limite_do_periodo INT;
    v_dia_semana INT;
    v_resumo_periodo RECORD;
BEGIN
    -- ========== ETAPA 1: BUSCAR CLIENTE ==========
    SELECT id, empresa_id INTO v_cliente_id, v_empresa_id
    FROM public.clientes 
    WHERE uuid_identificador = p_cliente_uuid;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('disponivel', false, 'motivo', 'Cliente não encontrado.');
    END IF;

    RAISE WARNING '✅ [ETAPA 1] Cliente ID: %, Empresa ID: %', v_cliente_id, v_empresa_id;

    -- ========== ETAPA 2: BUSCAR REGRAS ==========
    SELECT * INTO v_regras 
    FROM public.regras_de_reserva 
    WHERE empresa_id = v_empresa_id;
    
    IF NOT FOUND THEN 
        RAISE WARNING '⚠️ [ETAPA 2] Nenhuma regra encontrada';
        RETURN jsonb_build_object(
            'disponivel', true, 
            'empresa_id', v_empresa_id, 
            'min_convidados_reserva', 1, 
            'max_convidados_reserva', 50
        ); 
    END IF;

    RAISE WARNING '✅ [ETAPA 2] Regras carregadas';

    -- ========== VALIDAÇÃO 1: LIMITE DE PESSOAS ==========
    IF p_numero_de_pessoas < v_regras.limite_minimo_pessoas_reserva OR 
       p_numero_de_pessoas > v_regras.limite_maximo_pessoas_reserva THEN
        
        RAISE WARNING '❌ [VALIDAÇÃO 1] Fora do limite: % (min: %, max: %)', 
            p_numero_de_pessoas,
            v_regras.limite_minimo_pessoas_reserva,
            v_regras.limite_maximo_pessoas_reserva;
        
        RETURN jsonb_build_object(
            'disponivel', false, 
            'motivo', format('O número de convidados deve ser entre %s e %s.', 
                v_regras.limite_minimo_pessoas_reserva, 
                v_regras.limite_maximo_pessoas_reserva)
        );
    END IF;

    RAISE WARNING '✅ [VALIDAÇÃO 1] Número de pessoas OK';

    -- ========== VALIDAÇÃO 2: HORÁRIO LIMITE ==========
    IF p_data_desejada = CURRENT_DATE AND 
       v_regras.horario_limite_reserva_mesmo_dia IS NOT NULL THEN
        
        IF (NOW() AT TIME ZONE 'America/Sao_Paulo')::time > v_regras.horario_limite_reserva_mesmo_dia THEN
            RAISE WARNING '❌ [VALIDAÇÃO 2] Horário limite ultrapassado';
            RETURN jsonb_build_object('disponivel', false, 'motivo', 'Para hoje nosso horário limite para novas reservas já se encerrou. Agora somente por ordem de chegada.');
        END IF;
    END IF;

    RAISE WARNING '✅ [VALIDAÇÃO 2] Horário OK';

    -- ========== VALIDAÇÃO 3: FUNCIONAMENTO ==========
    v_dia_semana := CAST(to_char(p_data_desejada, 'D') AS INTEGER);
    
    SELECT * INTO v_periodo_funcionamento 
    FROM public.periodos_funcionamento 
    WHERE empresa_id = v_empresa_id 
      AND dia_semana = v_dia_semana
      AND nome_periodo = p_nome_periodo 
      AND ativo = true;
    
    IF NOT FOUND THEN
        RAISE WARNING '❌ [VALIDAÇÃO 3] Casa não abre neste dia/período';
        RETURN jsonb_build_object('disponivel', false, 'motivo', 'Não abrimos neste dia ou nesse período que você escolheu. Por favor consulte nosso horários de funcionamento pelo whatsapp.');
    END IF;

    RAISE WARNING '✅ [VALIDAÇÃO 3] Funcionamento OK';

    -- ========== VALIDAÇÃO 4: DIAS BLOQUEADOS ==========
    IF v_dia_semana = ANY(COALESCE(v_regras.dias_semana_indisponiveis, '{}')) THEN
        RAISE WARNING '❌ [VALIDAÇÃO 4] Dia da semana bloqueado';
        RETURN jsonb_build_object('disponivel', false, 'motivo', 'Não pegamos reservas nesse dia da semana.');
    END IF;

    RAISE WARNING '✅ [VALIDAÇÃO 4] Dia não bloqueado';

    -- ========== VALIDAÇÃO 5: EXCEÇÕES E LIMITE ==========
    SELECT * INTO v_excecao 
    FROM public.datas_excecao_reserva 
    WHERE empresa_id = v_empresa_id 
      AND data_excecao = p_data_desejada 
      AND nome_periodo = p_nome_periodo;
    
    IF FOUND THEN
        RAISE WARNING '🔍 [VALIDAÇÃO 5] Exceção encontrada - Limite: %', v_excecao.limite_maximo_convidados;
        
        IF v_excecao.limite_maximo_convidados = 0 THEN
            RAISE WARNING '❌ [VALIDAÇÃO 5] Data bloqueada (limite 0)';
            RETURN jsonb_build_object('disponivel', false, 'motivo', 'Data bloqueada.');
        END IF;
        
        v_limite_do_periodo := v_excecao.limite_maximo_convidados;
    ELSE
        RAISE WARNING '🔍 [VALIDAÇÃO 5] Sem exceção. Buscando no JSON...';
        
        -- Busca no JSON
        SELECT (elem->>'limite_convidados')::int INTO v_limite_do_periodo
        FROM jsonb_array_elements(v_regras.limites_por_periodo) elem
        WHERE elem->>'nome_periodo' = p_nome_periodo;
        
        IF v_limite_do_periodo IS NULL THEN
            RAISE WARNING '❌ [VALIDAÇÃO 5] Período "%s" não configurado no JSON', p_nome_periodo;
            RETURN jsonb_build_object(
                'disponivel', false, 
                'motivo', format('Período "%s" não configurado.', p_nome_periodo)
            );
        END IF;
        
        RAISE WARNING '✅ [VALIDAÇÃO 5] Limite do JSON: %', v_limite_do_periodo;
    END IF;

    -- ========================================================================
    -- ========== VALIDAÇÃO 6: CAPACIDADE (USANDO A VIEW) ===================
    -- ========================================================================
    
    RAISE WARNING '🔍 [VALIDAÇÃO 6] =====================================';
    RAISE WARNING '🔍 [VALIDAÇÃO 6] Buscando na VIEW resumo_reservas_diarias';
    RAISE WARNING '🔍 [VALIDAÇÃO 6] Empresa: %', v_empresa_id;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] Data: %', p_data_desejada;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] Período: "%"', p_nome_periodo;
    
    -- *** SOLUÇÃO: Usar a view que já funciona ***
    SELECT * INTO v_resumo_periodo
    FROM public.resumo_reservas_diarias
    WHERE empresa_id = v_empresa_id
      AND date = p_data_desejada
      AND periodo = p_nome_periodo;
    
    IF FOUND THEN
        -- Extrai o número de pessoas do formato "170 pessoas"
        v_total_convidados_no_periodo := CAST(
            SPLIT_PART(v_resumo_periodo.total_de_convidados, ' ', 1) AS INT
        );
        
        RAISE WARNING '✅ [VALIDAÇÃO 6] Dados encontrados na view!';
        RAISE WARNING '🔍 [VALIDAÇÃO 6] Total de convidados: %', v_total_convidados_no_periodo;
        RAISE WARNING '🔍 [VALIDAÇÃO 6] Total de reservas: %', v_resumo_periodo.total_de_reservas;
    ELSE
        -- Nenhuma reserva para este período ainda
        v_total_convidados_no_periodo := 0;
        RAISE WARNING '🔍 [VALIDAÇÃO 6] Nenhuma reserva encontrada (período vazio)';
    END IF;
    
    RAISE WARNING '🔍 [VALIDAÇÃO 6] -------------------------------------';
    RAISE WARNING '🔍 [VALIDAÇÃO 6] 📊 Ocupação atual: %', v_total_convidados_no_periodo;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] 📊 Limite do período: %', v_limite_do_periodo;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] 📊 Solicitando: %', p_numero_de_pessoas;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] 📊 Total após reserva: %', v_total_convidados_no_periodo + p_numero_de_pessoas;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] 📊 Vagas disponíveis: %', v_limite_do_periodo - v_total_convidados_no_periodo;
    
    -- VALIDAÇÃO FINAL
    IF (v_total_convidados_no_periodo + p_numero_de_pessoas) > v_limite_do_periodo THEN
        RAISE WARNING '❌❌❌ [VALIDAÇÃO 6] CAPACIDADE ESGOTADA! ❌❌❌';
        RAISE WARNING '❌ [VALIDAÇÃO 6] Cálculo: % + % = % > % (limite)', 
            v_total_convidados_no_periodo,
            p_numero_de_pessoas,
            v_total_convidados_no_periodo + p_numero_de_pessoas,
            v_limite_do_periodo;
        
        RETURN jsonb_build_object(
            'disponivel', false, 
            'motivo', format('Capacidade esgotada. Já temos %s pessoas confirmadas e o limite é %s. Sobraram apenas %s vagas.Agora somente por ordem de chegada. ', 
                v_total_convidados_no_periodo, 
                v_limite_do_periodo,
                GREATEST(0, v_limite_do_periodo - v_total_convidados_no_periodo)
            ),
            'detalhes', jsonb_build_object(
                'ocupacao_atual', v_total_convidados_no_periodo,
                'limite_periodo', v_limite_do_periodo,
                'solicitado', p_numero_de_pessoas,
                'vagas_disponiveis', GREATEST(0, v_limite_do_periodo - v_total_convidados_no_periodo),
                'excedente', (v_total_convidados_no_periodo + p_numero_de_pessoas) - v_limite_do_periodo
            )
        );
    END IF;

    RAISE WARNING '✅✅✅ [VALIDAÇÃO 6] CAPACIDADE OK! ✅✅✅';
    RAISE WARNING '✅ [VALIDAÇÃO 6] Vagas restantes: %', v_limite_do_periodo - v_total_convidados_no_periodo;
    RAISE WARNING '🔍 [VALIDAÇÃO 6] =====================================';

    -- ========== SUCESSO ==========
    RETURN jsonb_build_object(
        'disponivel', true,
        'empresa_id', v_empresa_id,
        'min_convidados_reserva', v_regras.limite_minimo_pessoas_reserva,
        'max_convidados_reserva', v_regras.limite_maximo_pessoas_reserva,
        'info', jsonb_build_object(
            'limite_periodo', v_limite_do_periodo,
            'ocupacao_atual', v_total_convidados_no_periodo,
            'vagas_restantes', v_limite_do_periodo - v_total_convidados_no_periodo
        )
    );
    
END;
$$;


ALTER FUNCTION "public"."verificar_disponibilidade"("p_cliente_uuid" "uuid", "p_data_desejada" "date", "p_nome_periodo" "text", "p_numero_de_pessoas" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."verificar_disponibilidade"("p_cliente_uuid" "uuid", "p_data_desejada" "date", "p_nome_periodo" "text", "p_numero_de_pessoas" integer) IS 'Valida disponibilidade usando a view resumo_reservas_diarias para cálculo preciso.
CORRIGIDO: Agora busca corretamente a ocupação por período.';



CREATE OR REPLACE FUNCTION "public"."verificar_permissao_usuario"("p_user_id" "uuid", "p_role_requerida" "public"."app_role") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role_do_usuario public.app_role;
BEGIN
  -- CORREÇÃO: Garante que o parâmetro é UUID e a comparação é feita corretamente.
  SELECT role INTO v_role_do_usuario FROM public.profiles WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- A lógica de hierarquia é a mesma da função principal.
  IF v_role_do_usuario IN ('dev', 'proprietario') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'adm' AND p_role_requerida IN ('adm', 'financeiro', 'gerente', 'metre', 'portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'gerente' AND p_role_requerida IN ('gerente', 'metre', 'portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'metre' AND p_role_requerida IN ('metre', 'portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'portaria' AND p_role_requerida IN ('portaria', 'garcon') THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'garcon' AND p_role_requerida = 'garcon' THEN
    RETURN TRUE;
  END IF;
  IF v_role_do_usuario = 'financeiro' AND p_role_requerida = 'financeiro' THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;


ALTER FUNCTION "public"."verificar_permissao_usuario"("p_user_id" "uuid", "p_role_requerida" "public"."app_role") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_invocations" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "empresa_id" bigint NOT NULL,
    "nome_agente" "text" NOT NULL,
    "compelition_id" bigint,
    "cliente_id" bigint
);


ALTER TABLE "public"."agent_invocations" OWNER TO "postgres";


COMMENT ON TABLE "public"."agent_invocations" IS 'Registra cada vez que um agente especialista é acionado pelo roteador.';



ALTER TABLE "public"."agent_invocations" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."agent_invocations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."analytics_aggregates" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "periodo_tipo" "text" NOT NULL,
    "periodo_inicio" "date" NOT NULL,
    "nome_agente" "text" NOT NULL,
    "total_invocacoes" bigint NOT NULL,
    CONSTRAINT "analytics_aggregates_periodo_tipo_check" CHECK (("periodo_tipo" = ANY (ARRAY['daily'::"text", 'monthly'::"text", 'yearly'::"text"])))
);


ALTER TABLE "public"."analytics_aggregates" OWNER TO "postgres";


COMMENT ON TABLE "public"."analytics_aggregates" IS 'Armazena agregados pré-calculados de métricas de agentes para o dashboard.';



ALTER TABLE "public"."analytics_aggregates" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."analytics_aggregates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "openai_api_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "wa_me_key" "text",
    "whatsapp_phone_number_id" "text",
    "whatsapp_access_token" "text"
);


ALTER TABLE "public"."api_keys" OWNER TO "postgres";


COMMENT ON TABLE "public"."api_keys" IS 'Armazena chaves de API de serviços externos para cada empresa de forma segura.';



COMMENT ON COLUMN "public"."api_keys"."openai_api_key" IS 'A chave de API da OpenAI específica para esta empresa.';



COMMENT ON COLUMN "public"."api_keys"."wa_me_key" IS 'Armazena a chave (key) da API api-wa.me para cada empresa.';



COMMENT ON COLUMN "public"."api_keys"."whatsapp_phone_number_id" IS 'Phone Number ID da API oficial do WhatsApp (Meta/Facebook). Exemplo: 294702937158322. Este ID identifica o número de WhatsApp Business da empresa no Meta.';



COMMENT ON COLUMN "public"."api_keys"."whatsapp_access_token" IS 'Access Token permanente da API oficial do WhatsApp (Meta/Facebook). Cada empresa tem seu próprio token.';



ALTER TABLE "public"."api_keys" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."api_keys_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."chatsZap" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "modificado" timestamp without time zone DEFAULT "now"(),
    "clientes_id" bigint,
    "empresa_id" bigint,
    "instancia" "text",
    "chatId" "text",
    "from" "text",
    "tsData" timestamp without time zone,
    "mensagem" "text",
    "resposta" "text",
    "event" "text",
    "type" "text",
    "notfyName" "text",
    "menuEstatico" boolean DEFAULT false,
    "temAudio" boolean DEFAULT false NOT NULL,
    "agregado" boolean DEFAULT false NOT NULL,
    "enviado_pelo_operador" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."chatsZap" OWNER TO "postgres";


COMMENT ON COLUMN "public"."chatsZap"."enviado_pelo_operador" IS 'Verdadeiro se a mensagem foi enviada por um funcionário pelo painel de gestão, falso se foi recebida do cliente.';



ALTER TABLE "public"."chatsZap" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."chatsZap_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."clientes" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "modifyed_at" timestamp without time zone DEFAULT "now"(),
    "nome" "text" DEFAULT ''::"text",
    "foto" "text" DEFAULT ''::"text",
    "empresa" "text" DEFAULT ''::"text",
    "empresa_id" bigint,
    "chatId" "text" DEFAULT ''::"text",
    "instancia" "text" DEFAULT ''::"text",
    "aniversario" "date",
    "niver" timestamp without time zone,
    "temReserva" boolean DEFAULT false,
    "reservas_id" bigint,
    "reservaData" timestamp without time zone,
    "ultimaReserva" timestamp without time zone,
    "ultimoCheckIn" "text",
    "vizitas" bigint,
    "reservasFeitas" bigint,
    "convidados" double precision,
    "noShow" bigint,
    "temCrianca" boolean DEFAULT false,
    "mesa" "text" DEFAULT ''::"text",
    "compelitions" "jsonb",
    "mensagemAgregada" "text" DEFAULT ''::"text",
    "ultimoChatZap" bigint,
    "agendado" boolean DEFAULT false,
    "modificado_por" bigint,
    "atendido_por" "uuid",
    "ia_muted_until" timestamp with time zone,
    "ia_suspended" boolean DEFAULT false NOT NULL,
    "criado" "text",
    "ultimo_checkin" "text",
    "aniver" "text",
    "uuid_identificador" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "openai_last_response_id" "text",
    "conversation_id" "text"
);


ALTER TABLE "public"."clientes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."clientes"."atendido_por" IS 'ID do perfil do funcionário que assumiu o atendimento deste cliente.';



COMMENT ON COLUMN "public"."clientes"."ia_muted_until" IS 'Timestamp até o qual a IA está temporariamente silenciada para este cliente.';



COMMENT ON COLUMN "public"."clientes"."ia_suspended" IS 'Se verdadeiro, a IA está permanentemente suspensa para este cliente.';



COMMENT ON COLUMN "public"."clientes"."uuid_identificador" IS 'Identificador único e seguro (UUID) para uso em URLs e APIs externas.';



COMMENT ON COLUMN "public"."clientes"."conversation_id" IS 'ID da conversation na OpenAI Responses API (formato: conv_XXX). Válido por 30 dias.';



CREATE TABLE IF NOT EXISTS "public"."reservas" (
    "id" bigint NOT NULL,
    "empresa_id" bigint,
    "clientes_id" bigint,
    "confirmada_por" "text",
    "chat_id" "text",
    "nome" "text",
    "instancia" bigint,
    "data_reserva" "date" NOT NULL,
    "horario" "text",
    "convidados" integer,
    "adultos" integer NOT NULL,
    "criancas" integer DEFAULT 0,
    "confirmados" integer DEFAULT 0,
    "observacoes" "text",
    "aniversario" boolean DEFAULT false,
    "codigo" "text",
    "condicoes_especiais" "text"[],
    "condicoes_text" "text",
    "de_prioridade" boolean DEFAULT false,
    "confirmada" boolean DEFAULT false,
    "confirmada_automaticamente" boolean DEFAULT false,
    "confirmada_dia_reserva" boolean DEFAULT false,
    "cancelada_cliente" boolean DEFAULT false,
    "cancelada_casa" boolean DEFAULT false,
    "finalizada" boolean DEFAULT false,
    "no_show" boolean DEFAULT false,
    "editar" boolean DEFAULT false,
    "mesa" "text",
    "novo_nome" "text",
    "novo_convidados" integer,
    "novo_adultos" integer,
    "novo_crianca" integer,
    "nova_observacao" "text",
    "nova_data" "date",
    "novo_horario" "text",
    "nova_prioridade" boolean,
    "novo_timestamp" timestamp with time zone,
    "ts_data" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "criada_por" "uuid",
    "reserva_anonima" boolean DEFAULT false NOT NULL,
    "cliente_xano" smallint,
    "id_xano" smallint
);


ALTER TABLE "public"."reservas" OWNER TO "postgres";


COMMENT ON TABLE "public"."reservas" IS 'Armazena as reservas feitas pelos clientes, incluindo detalhes de edição e status.';



COMMENT ON COLUMN "public"."reservas"."criada_por" IS 'ID do perfil do funcionário que criou a reserva manualmente.';



COMMENT ON COLUMN "public"."reservas"."reserva_anonima" IS 'Verdadeiro se a reserva foi criada manualmente sem um cliente associado via WhatsApp.';



CREATE OR REPLACE VIEW "public"."clientes_com_reserva_ativa" AS
 SELECT "c"."id" AS "cliente_id",
    "c"."nome" AS "nome_cliente",
    "replace"("c"."chatId", '@c.us'::"text", ''::"text") AS "whatsapp",
    "c"."empresa_id",
    "to_char"("c"."niver", 'DD/MM/YYYY'::"text") AS "aniversario",
    "to_char"("c"."ultimaReserva", 'DD/MM/YYYY'::"text") AS "data_ultima_reserva_formatada",
    "c"."ultimoCheckIn" AS "ultimo_checkin",
    "c"."vizitas",
    "c"."reservasFeitas",
    "c"."noShow",
    "c"."ia_suspended",
    "r"."id" AS "reserva_id_atual",
    "r"."nome" AS "nome_reserva_atual",
    "to_char"(("r"."data_reserva")::timestamp with time zone, 'DD/MM/YYYY'::"text") AS "data_reserva_atual",
    "r"."adultos" AS "adultos_reserva_atual",
    "r"."criancas" AS "criancas_reserva_atual",
    "r"."observacoes" AS "observacoes_reserva_atual",
    "r"."confirmada" AS "reserva_atual_confirmada",
    "r"."editar" AS "reserva_atual_em_edicao",
    "r"."confirmada_dia_reserva" AS "confirmada_pelo_cliente",
    "to_char"("r"."created_at", 'DD/MM/YYYY'::"text") AS "feita_dia"
   FROM ("public"."clientes" "c"
     JOIN LATERAL ( SELECT "r_1"."id",
            "r_1"."empresa_id",
            "r_1"."clientes_id",
            "r_1"."confirmada_por",
            "r_1"."chat_id",
            "r_1"."nome",
            "r_1"."instancia",
            "r_1"."data_reserva",
            "r_1"."horario",
            "r_1"."convidados",
            "r_1"."adultos",
            "r_1"."criancas",
            "r_1"."confirmados",
            "r_1"."observacoes",
            "r_1"."aniversario",
            "r_1"."codigo",
            "r_1"."condicoes_especiais",
            "r_1"."condicoes_text",
            "r_1"."de_prioridade",
            "r_1"."confirmada",
            "r_1"."confirmada_automaticamente",
            "r_1"."confirmada_dia_reserva",
            "r_1"."cancelada_cliente",
            "r_1"."cancelada_casa",
            "r_1"."finalizada",
            "r_1"."no_show",
            "r_1"."editar",
            "r_1"."mesa",
            "r_1"."novo_nome",
            "r_1"."novo_convidados",
            "r_1"."novo_adultos",
            "r_1"."novo_crianca",
            "r_1"."nova_observacao",
            "r_1"."nova_data",
            "r_1"."novo_horario",
            "r_1"."nova_prioridade",
            "r_1"."novo_timestamp",
            "r_1"."ts_data",
            "r_1"."created_at",
            "r_1"."criada_por",
            "r_1"."reserva_anonima",
            "r_1"."cliente_xano",
            "r_1"."id_xano"
           FROM "public"."reservas" "r_1"
          WHERE (("r_1"."clientes_id" = "c"."id") AND ("r_1"."data_reserva" >= CURRENT_DATE) AND ("r_1"."cancelada_cliente" = false) AND ("r_1"."cancelada_casa" = false))
          ORDER BY "r_1"."data_reserva", "r_1"."created_at" DESC
         LIMIT 1) "r" ON (true));


ALTER VIEW "public"."clientes_com_reserva_ativa" OWNER TO "postgres";


ALTER TABLE "public"."clientes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."clientes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."compelition" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cliente" bigint NOT NULL,
    "tokens" bigint,
    "modificadoEm" timestamp with time zone DEFAULT "now"(),
    "chat" "jsonb",
    "empresa" bigint,
    "chat_teste" "jsonb"
);


ALTER TABLE "public"."compelition" OWNER TO "postgres";


COMMENT ON COLUMN "public"."compelition"."chat_teste" IS 'Armazena o histórico da conversa gerado pelo sistema de agentes de teste, para fins de comparação e validação.';



ALTER TABLE "public"."compelition" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."compelitionsd_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contratos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "telefone" "text" NOT NULL,
    "nome" "text",
    "numero_contrato" "text",
    "banco" "text",
    "parcelas" integer,
    "valor_parcela" numeric(10,2),
    "prazo_contrato" integer,
    "parcelas_pagas" integer,
    "parcelas_em_aberto" integer,
    "parcelas_atrasadas" integer,
    "valor_total_contrato" numeric(12,2),
    "valor_estimado_quitacao" numeric(12,2),
    "percentual_desconto" numeric(5,2),
    "foto_contrato" "text",
    "arquivo_contrato" "text",
    "status" "text" DEFAULT 'novo'::"text",
    "observacoes" "text",
    "agendamento_ligacao" timestamp with time zone,
    "vendedor_responsavel" "text",
    "cliente_id" bigint,
    "nome_pai" "text",
    "nome_mae" "text",
    "conversation_id" "text"
);


ALTER TABLE "public"."contratos" OWNER TO "postgres";


COMMENT ON TABLE "public"."contratos" IS 'Leads de financiamento coletados via WhatsApp';



COMMENT ON COLUMN "public"."contratos"."foto_contrato" IS 'URL da foto/screenshot enviada pelo cliente';



COMMENT ON COLUMN "public"."contratos"."arquivo_contrato" IS 'URL do PDF do contrato enviado pelo cliente';



COMMENT ON COLUMN "public"."contratos"."status" IS 'novo, quente, morno, frio, convertido, perdido';



CREATE TABLE IF NOT EXISTS "public"."convites_beta" (
    "id" bigint NOT NULL,
    "chat_id" "text" NOT NULL,
    "nome_destinatario" "text",
    "usado" boolean DEFAULT false NOT NULL,
    "criado_em" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."convites_beta" OWNER TO "postgres";


COMMENT ON TABLE "public"."convites_beta" IS 'Armazena a lista de números de telefone autorizados a se cadastrarem durante a fase beta.';



ALTER TABLE "public"."convites_beta" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."convites_beta_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."dados_do_cliente" AS
 SELECT "c"."id" AS "cliente_id",
    "c"."nome" AS "nome_cliente",
    "replace"("c"."chatId", '@c.us'::"text", ''::"text") AS "whatsapp",
    "c"."empresa_id",
    "to_char"("c"."niver", 'DD/MM/YYYY'::"text") AS "aniversario",
    "to_char"("c"."ultimaReserva", 'DD/MM/YYYY'::"text") AS "data_ultima_reserva_formatada",
    "c"."ultimoCheckIn" AS "ultimo_checkin",
    "c"."vizitas",
    "c"."reservasFeitas",
    "c"."noShow",
    "c"."ia_suspended",
    "r"."id" AS "reserva_id_atual",
    "r"."nome" AS "nome_reserva_atual",
    "to_char"(("r"."data_reserva")::timestamp with time zone, 'DD/MM/YYYY'::"text") AS "data_reserva_atual",
    "r"."adultos" AS "adultos_reserva_atual",
    "r"."criancas" AS "criancas_reserva_atual",
    "r"."observacoes" AS "observacoes_reserva_atual",
    "r"."confirmada" AS "reserva_atual_confirmada",
    "r"."editar" AS "reserva_atual_em_edicao",
    "r"."confirmada_dia_reserva" AS "confirmada_pelo_cliente",
    "to_char"("r"."created_at", 'DD/MM/YYYY'::"text") AS "feita_dia"
   FROM ("public"."clientes" "c"
     LEFT JOIN LATERAL ( SELECT "r_1"."id",
            "r_1"."empresa_id",
            "r_1"."clientes_id",
            "r_1"."confirmada_por",
            "r_1"."chat_id",
            "r_1"."nome",
            "r_1"."instancia",
            "r_1"."data_reserva",
            "r_1"."horario",
            "r_1"."convidados",
            "r_1"."adultos",
            "r_1"."criancas",
            "r_1"."confirmados",
            "r_1"."observacoes",
            "r_1"."aniversario",
            "r_1"."codigo",
            "r_1"."condicoes_especiais",
            "r_1"."condicoes_text",
            "r_1"."de_prioridade",
            "r_1"."confirmada",
            "r_1"."confirmada_automaticamente",
            "r_1"."confirmada_dia_reserva",
            "r_1"."cancelada_cliente",
            "r_1"."cancelada_casa",
            "r_1"."finalizada",
            "r_1"."no_show",
            "r_1"."editar",
            "r_1"."mesa",
            "r_1"."novo_nome",
            "r_1"."novo_convidados",
            "r_1"."novo_adultos",
            "r_1"."novo_crianca",
            "r_1"."nova_observacao",
            "r_1"."nova_data",
            "r_1"."novo_horario",
            "r_1"."nova_prioridade",
            "r_1"."novo_timestamp",
            "r_1"."ts_data",
            "r_1"."created_at",
            "r_1"."criada_por",
            "r_1"."reserva_anonima",
            "r_1"."cliente_xano",
            "r_1"."id_xano"
           FROM "public"."reservas" "r_1"
          WHERE (("r_1"."clientes_id" = "c"."id") AND ("r_1"."data_reserva" >= CURRENT_DATE) AND ("r_1"."cancelada_cliente" = false) AND ("r_1"."cancelada_casa" = false))
          ORDER BY "r_1"."data_reserva", "r_1"."created_at" DESC
         LIMIT 1) "r" ON (true));


ALTER VIEW "public"."dados_do_cliente" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."daily_metrics_by_company" AS
 WITH "daily_reservations" AS (
         SELECT "reservas"."empresa_id",
            "reservas"."data_reserva" AS "dia",
            "count"(*) AS "total_reservas",
            "sum"(("reservas"."adultos" + COALESCE("reservas"."criancas", 0))) AS "total_convidados"
           FROM "public"."reservas"
          WHERE (("reservas"."confirmada" = true) AND ("reservas"."cancelada_cliente" = false) AND ("reservas"."cancelada_casa" = false))
          GROUP BY "reservas"."empresa_id", "reservas"."data_reserva"
        ), "daily_chats" AS (
         SELECT "clientes"."empresa_id",
            ("clientes"."created_at")::"date" AS "dia",
            "count"(*) AS "total_conversas"
           FROM "public"."clientes"
          GROUP BY "clientes"."empresa_id", (("clientes"."created_at")::"date")
        )
 SELECT COALESCE("dr"."dia", "dc"."dia") AS "metrica_dia",
    COALESCE("dr"."empresa_id", "dc"."empresa_id") AS "empresa_id",
    COALESCE("dr"."total_reservas", (0)::bigint) AS "total_reservas",
    COALESCE("dr"."total_convidados", (0)::bigint) AS "total_convidados",
    COALESCE("dc"."total_conversas", (0)::bigint) AS "total_conversas"
   FROM ("daily_reservations" "dr"
     FULL JOIN "daily_chats" "dc" ON ((("dr"."dia" = "dc"."dia") AND ("dr"."empresa_id" = "dc"."empresa_id"))))
  ORDER BY COALESCE("dr"."dia", "dc"."dia")
  WITH NO DATA;


ALTER MATERIALIZED VIEW "public"."daily_metrics_by_company" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."datas_excecao_reserva" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "data_excecao" "date" NOT NULL,
    "nome_periodo" "text" DEFAULT 'Dia Inteiro'::"text" NOT NULL,
    "limite_maximo_convidados" integer DEFAULT 0 NOT NULL,
    "motivo" "text"
);


ALTER TABLE "public"."datas_excecao_reserva" OWNER TO "postgres";


COMMENT ON TABLE "public"."datas_excecao_reserva" IS 'Armazena regras de exceção para datas e períodos específicos.';



COMMENT ON COLUMN "public"."datas_excecao_reserva"."limite_maximo_convidados" IS 'Capacidade máxima de convidados para esta data/período. Se 0, o período está bloqueado.';



ALTER TABLE "public"."datas_excecao_reserva" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."datas_excecao_reserva_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."empresa" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "modificadoDia" timestamp without time zone DEFAULT "now"(),
    "razaoSocial" "text",
    "fantasia" "text",
    "modificadoPor" bigint,
    "contatoPrincipal" "text",
    "logo" "text",
    "instanciaChat" "text",
    "senhaWiFi" "text",
    "LimiteDeReservasPorDia" bigint,
    "LimiteDeConvidadosPorReserva" bigint,
    "reservasAutomaticas" bigint,
    "prompt" character varying,
    "adm" bigint,
    "contatoSoReserva" "text"[],
    "respostas_prontas" "text"[],
    "em_teste" boolean DEFAULT false,
    "contato_respostas" "text"[],
    "contato_vagas_de_emprego" "text"[],
    "contato_fornecedores" "text"[],
    "contato_teste" "text",
    "api_provider" "public"."api_provider_type" DEFAULT 'wappi'::"public"."api_provider_type" NOT NULL,
    "modo_ia" "public"."modo_ia_type" DEFAULT 'prompt_unico'::"public"."modo_ia_type" NOT NULL,
    "cor" "text" DEFAULT '#000000'::"text"
);


ALTER TABLE "public"."empresa" OWNER TO "postgres";


COMMENT ON COLUMN "public"."empresa"."contatoSoReserva" IS 'contatos da emoresa para enviar as reservas criadas';



COMMENT ON COLUMN "public"."empresa"."respostas_prontas" IS 'Armazena uma lista de mensagens prontas para serem usadas como ressalva ao recusar reservas.';



COMMENT ON COLUMN "public"."empresa"."contato_respostas" IS 'Lista de chatIds da equipe que deve receber o feedback de monitoramento das respostas da IA.';



COMMENT ON COLUMN "public"."empresa"."contato_teste" IS 'Campo de teste para novos contatos ou lógicas de notificação.';



COMMENT ON COLUMN "public"."empresa"."api_provider" IS 'Define qual provedor de API de WhatsApp esta empresa utiliza (wappi ou wame).';



COMMENT ON COLUMN "public"."empresa"."modo_ia" IS 'Define qual motor de IA a empresa utiliza.';



ALTER TABLE "public"."empresa" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."empresa_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."eventos" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "data_evento" "date" NOT NULL,
    "titulo" "text" NOT NULL,
    "descricao" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."eventos" OWNER TO "postgres";


COMMENT ON TABLE "public"."eventos" IS 'Armazena os eventos programados para cada empresa, como música ao vivo, jogos, etc.';



COMMENT ON COLUMN "public"."eventos"."data_evento" IS 'Data em que o evento ocorre (formato AAAA-MM-DD).';



COMMENT ON COLUMN "public"."eventos"."titulo" IS 'Um título curto e claro para o evento. Ex: "Música Ao Vivo".';



COMMENT ON COLUMN "public"."eventos"."descricao" IS 'Detalhes específicos do evento. Ex: "Show com a banda Samba do Zé a partir das 21h".';



ALTER TABLE "public"."eventos" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."eventos_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."functions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "nome" "text",
    "empresa" bigint,
    "function" "jsonb",
    "edge_function_name" "text",
    "tool_secundaria" boolean DEFAULT false NOT NULL,
    "prompt_id" bigint
);


ALTER TABLE "public"."functions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."functions"."edge_function_name" IS 'O nome da Edge Function a ser invocada quando esta ferramenta for acionada.';



COMMENT ON COLUMN "public"."functions"."tool_secundaria" IS 'Se true, esta é uma ferramenta granular para um agente especialista. Se false, é uma ferramenta de alto nível para o roteador.';



COMMENT ON COLUMN "public"."functions"."prompt_id" IS 'O ID do agente (da tabela prompt) que tem permissão para usar esta ferramenta.';



ALTER TABLE "public"."functions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."functions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."periodos_funcionamento" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "dia_semana" integer NOT NULL,
    "nome_periodo" "text" NOT NULL,
    "horario_inicio" time without time zone NOT NULL,
    "horario_fim" time without time zone NOT NULL,
    "promocao" "text",
    "atracao" "text",
    "cardapio" "text",
    "ativo" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "data_especial" boolean DEFAULT false NOT NULL,
    "data_evento_especial" "date",
    CONSTRAINT "periodos_funcionamento_dia_semana_check" CHECK ((("dia_semana" >= 1) AND ("dia_semana" <= 7)))
);


ALTER TABLE "public"."periodos_funcionamento" OWNER TO "postgres";


COMMENT ON TABLE "public"."periodos_funcionamento" IS 'Armazena os períodos de funcionamento e as atrações de cada dia da semana.';



COMMENT ON COLUMN "public"."periodos_funcionamento"."dia_semana" IS 'Representação numérica do dia da semana (1=Domingo, 2=Segunda, ..., 7=Sábado) para facilitar a ordenação.';



COMMENT ON COLUMN "public"."periodos_funcionamento"."nome_periodo" IS 'Identifica o período do dia, como "Almoço" ou "A noite".';



COMMENT ON COLUMN "public"."periodos_funcionamento"."data_especial" IS 'Se true, este é um período para uma data específica (feriado, etc.).';



COMMENT ON COLUMN "public"."periodos_funcionamento"."data_evento_especial" IS 'A data específica para o período especial (ex: 2025-12-25).';



ALTER TABLE "public"."periodos_funcionamento" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."periodos_funcionamento_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "empresa_id" bigint,
    "role" "public"."app_role" DEFAULT 'garcon'::"public"."app_role" NOT NULL,
    "nome" "text",
    "email" "text",
    "foto_url" "text",
    "telefone" "text",
    "chat_id" "text",
    "ativo" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "cadastro_concluido" boolean DEFAULT false NOT NULL,
    "ddd" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS 'Armazena os perfis dos usuários, estendendo a tabela auth.users.';



COMMENT ON COLUMN "public"."profiles"."cadastro_concluido" IS 'Indica se o usuário completou o preenchimento de seus dados básicos (nome, foto, etc.).';



COMMENT ON COLUMN "public"."profiles"."ddd" IS 'Código de área (DDD) do telefone do usuário.';



CREATE TABLE IF NOT EXISTS "public"."prompt" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "modificado" timestamp with time zone DEFAULT "now"(),
    "empresa" bigint,
    "prompt" "text",
    "tools" "jsonb"[],
    "arquivo" "jsonb"[],
    "eventos" "text",
    "instrucao_inicial" "text",
    "funcionamento" "text",
    "datas_especiais" "text",
    "regulamento_reserva" "text",
    "prompt_base" "text",
    "instrucao_de_funcionamento" "text",
    "nome_agente" "text",
    "modelo_ia" "text" DEFAULT '''gpt-4.1-mini''::text'::"text" NOT NULL,
    "tipo_prompt" "public"."prompt_type" DEFAULT 'geral'::"public"."prompt_type" NOT NULL
);


ALTER TABLE "public"."prompt" OWNER TO "postgres";


COMMENT ON TABLE "public"."prompt" IS 'Armazena as partes segmentadas do prompt para ser montado dinamicamente. Cada linha representa o prompt de uma empresa.';



COMMENT ON COLUMN "public"."prompt"."eventos" IS 'Agenda de eventos em XML, gerada por outro gatilho.';



COMMENT ON COLUMN "public"."prompt"."funcionamento" IS 'Texto gerado automaticamente com os horários de funcionamento da semana.';



COMMENT ON COLUMN "public"."prompt"."datas_especiais" IS 'Texto gerado automaticamente com os horários para datas especiais.';



COMMENT ON COLUMN "public"."prompt"."regulamento_reserva" IS 'Armazena o texto do regulamento a ser enviado ao cliente na confirmação da reserva.';



COMMENT ON COLUMN "public"."prompt"."prompt_base" IS 'Instruções base e estáticas sobre a identidade e o comportamento geral da IA.';



COMMENT ON COLUMN "public"."prompt"."nome_agente" IS 'O nome único do agente (ex: roteador_principal, agente_reservas) ao qual este prompt pertence.';



COMMENT ON COLUMN "public"."prompt"."modelo_ia" IS 'O identificador do modelo da OpenAI a ser usado por este agente (ex: gpt-4o-mini).';



COMMENT ON COLUMN "public"."prompt"."tipo_prompt" IS 'Define a finalidade deste prompt (ex: roteador, reservas, funcionamento).';



ALTER TABLE "public"."prompt" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."prompt_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."prompt_reserva" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "prompt_texto" "text",
    "tools" "jsonb",
    "reservas_desabilitadas" boolean DEFAULT false NOT NULL,
    "limite_minimo_pessoas" integer DEFAULT 1 NOT NULL,
    "limite_maximo_pessoas" integer DEFAULT 100 NOT NULL,
    "horario_limite_reserva" time without time zone,
    "dias_semana_indisponiveis" "text"[],
    "datas_indisponiveis" "date"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."prompt_reserva" OWNER TO "postgres";


COMMENT ON TABLE "public"."prompt_reserva" IS 'Armazena regras de negócio e o contexto de IA (prompt e tools) para o sistema de reservas.';



COMMENT ON COLUMN "public"."prompt_reserva"."prompt_texto" IS 'O prompt de sistema focado apenas em regras e comportamento de reservas.';



COMMENT ON COLUMN "public"."prompt_reserva"."tools" IS 'O array de definições de ferramentas JSON que o agente de reservas pode acionar.';



COMMENT ON COLUMN "public"."prompt_reserva"."reservas_desabilitadas" IS 'Se true, desabilita completamente a criação de novas reservas.';



COMMENT ON COLUMN "public"."prompt_reserva"."horario_limite_reserva" IS 'Horário de corte no dia para aceitar novas reservas (formato HH24:MI:SS).';



COMMENT ON COLUMN "public"."prompt_reserva"."dias_semana_indisponiveis" IS 'Array de textos representando os dias da semana em que não se aceitam reservas (ex: ''Domingo'', ''Segunda-feira'').';



COMMENT ON COLUMN "public"."prompt_reserva"."datas_indisponiveis" IS 'Array de datas específicas em que o estabelecimento está fechado ou não aceita reservas.';



ALTER TABLE "public"."prompt_reserva" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."prompt_reserva_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."regras_de_reserva" (
    "id" bigint NOT NULL,
    "empresa_id" bigint NOT NULL,
    "dias_semana_indisponiveis" integer[],
    "horario_limite_reserva_mesmo_dia" time without time zone,
    "limite_minimo_pessoas_reserva" integer DEFAULT 1 NOT NULL,
    "limite_maximo_pessoas_reserva" integer DEFAULT 50 NOT NULL,
    "limites_por_periodo" "jsonb"
);


ALTER TABLE "public"."regras_de_reserva" OWNER TO "postgres";


COMMENT ON TABLE "public"."regras_de_reserva" IS 'Armazena as regras de negócio recorrentes para o sistema de reservas.';



COMMENT ON COLUMN "public"."regras_de_reserva"."dias_semana_indisponiveis" IS 'Array de números para dias bloqueados (1=Dom, 2=Seg, ..., 7=Sáb).';



COMMENT ON COLUMN "public"."regras_de_reserva"."limites_por_periodo" IS 'Array JSON com os limites de convidados para cada período do dia.';



ALTER TABLE "public"."regras_de_reserva" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."regras_de_reserva_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."reservas_futuras" AS
 SELECT "r"."id",
    "r"."empresa_id",
    "r"."clientes_id",
    "r"."confirmada_por",
    "r"."chat_id",
    "r"."nome",
    "r"."instancia",
    "r"."data_reserva",
    "r"."horario",
    "r"."convidados",
    "r"."adultos",
    "r"."criancas",
    "r"."confirmados",
    "r"."observacoes",
    "r"."aniversario",
    "r"."codigo",
    "r"."condicoes_especiais",
    "r"."condicoes_text",
    "r"."de_prioridade",
    "r"."confirmada",
    "r"."confirmada_automaticamente",
    "r"."confirmada_dia_reserva",
    "r"."cancelada_cliente",
    "r"."cancelada_casa",
    "r"."finalizada",
    "r"."no_show",
    "r"."editar",
    "r"."mesa",
    "r"."novo_nome",
    "r"."novo_convidados",
    "r"."novo_adultos",
    "r"."novo_crianca",
    "r"."nova_observacao",
    "r"."nova_data",
    "r"."novo_horario",
    "r"."nova_prioridade",
    "r"."novo_timestamp",
    "r"."ts_data",
    "r"."created_at",
    "r"."criada_por",
    "r"."reserva_anonima",
    "r"."cliente_xano",
    "r"."id_xano",
    "c"."uuid_identificador" AS "cliente_uuid"
   FROM ("public"."reservas" "r"
     LEFT JOIN "public"."clientes" "c" ON (("r"."clientes_id" = "c"."id")))
  WHERE (("r"."data_reserva" >= CURRENT_DATE) AND ("r"."cancelada_cliente" = false) AND ("r"."cancelada_casa" = false));


ALTER VIEW "public"."reservas_futuras" OWNER TO "postgres";


ALTER TABLE "public"."reservas" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."reservas_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."resumo_reservas_diarias" AS
 SELECT "empresa_id",
    "data_reserva" AS "date",
    "horario" AS "periodo",
    ("sum"((COALESCE("adultos", 0) + COALESCE("criancas", 0))) || ' pessoas'::"text") AS "total_de_convidados",
    ("count"("id") || ' reservas'::"text") AS "total_de_reservas"
   FROM "public"."reservas" "r"
  WHERE (("cancelada_cliente" = false) AND ("cancelada_casa" = false) AND ("data_reserva" >= CURRENT_DATE))
  GROUP BY "empresa_id", "data_reserva", "horario"
  ORDER BY "data_reserva", "horario";


ALTER VIEW "public"."resumo_reservas_diarias" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."solicitacoes_de_convite" (
    "id" bigint NOT NULL,
    "chat_id" "text" NOT NULL,
    "data_solicitacao" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."solicitacoes_de_convite" OWNER TO "postgres";


COMMENT ON TABLE "public"."solicitacoes_de_convite" IS 'Funciona como uma "lista de espera", capturando os contactos de interessados que tentaram o cadastro sem convite.';



ALTER TABLE "public"."solicitacoes_de_convite" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."solicitacoes_de_convite_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."user" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user" OWNER TO "postgres";


ALTER TABLE "public"."user" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."user_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."v_debug_mode" (
    "?column?" boolean
);


ALTER TABLE "public"."v_debug_mode" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."view_leads_resumo" AS
 SELECT "status",
    "count"(*) AS "total",
    "sum"("valor_estimado_quitacao") AS "valor_total_potencial"
   FROM "public"."contratos"
  GROUP BY "status";


ALTER VIEW "public"."view_leads_resumo" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_invocations"
    ADD CONSTRAINT "agent_invocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."analytics_aggregates"
    ADD CONSTRAINT "analytics_aggregates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_empresa_id_key" UNIQUE ("empresa_id");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chatsZap"
    ADD CONSTRAINT "chatsZap_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_uuid_identificador_unique" UNIQUE ("uuid_identificador");



ALTER TABLE ONLY "public"."compelition"
    ADD CONSTRAINT "compelitionsd_cliente_key" UNIQUE ("cliente");



ALTER TABLE ONLY "public"."compelition"
    ADD CONSTRAINT "compelitionsd_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contratos"
    ADD CONSTRAINT "contratos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."convites_beta"
    ADD CONSTRAINT "convites_beta_chat_id_key" UNIQUE ("chat_id");



ALTER TABLE ONLY "public"."convites_beta"
    ADD CONSTRAINT "convites_beta_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."datas_excecao_reserva"
    ADD CONSTRAINT "datas_excecao_reserva_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."empresa"
    ADD CONSTRAINT "empresa_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eventos"
    ADD CONSTRAINT "eventos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."functions"
    ADD CONSTRAINT "functions_empresa_nome_unique" UNIQUE ("empresa", "nome");



ALTER TABLE ONLY "public"."functions"
    ADD CONSTRAINT "functions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."periodos_funcionamento"
    ADD CONSTRAINT "periodos_funcionamento_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prompt"
    ADD CONSTRAINT "prompt_empresa_nome_agente_key" UNIQUE ("empresa", "nome_agente");



ALTER TABLE ONLY "public"."prompt"
    ADD CONSTRAINT "prompt_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prompt_reserva"
    ADD CONSTRAINT "prompt_reserva_empresa_id_key" UNIQUE ("empresa_id");



ALTER TABLE ONLY "public"."prompt_reserva"
    ADD CONSTRAINT "prompt_reserva_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."regras_de_reserva"
    ADD CONSTRAINT "regras_de_reserva_empresa_id_key" UNIQUE ("empresa_id");



ALTER TABLE ONLY "public"."regras_de_reserva"
    ADD CONSTRAINT "regras_de_reserva_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reservas"
    ADD CONSTRAINT "reservas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."solicitacoes_de_convite"
    ADD CONSTRAINT "solicitacoes_de_convite_chat_id_key" UNIQUE ("chat_id");



ALTER TABLE ONLY "public"."solicitacoes_de_convite"
    ADD CONSTRAINT "solicitacoes_de_convite_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."analytics_aggregates"
    ADD CONSTRAINT "unique_aggregate" UNIQUE ("empresa_id", "periodo_tipo", "periodo_inicio", "nome_agente");



ALTER TABLE ONLY "public"."datas_excecao_reserva"
    ADD CONSTRAINT "unique_empresa_data_periodo_excecao" UNIQUE ("empresa_id", "data_excecao", "nome_periodo");



ALTER TABLE ONLY "public"."user"
    ADD CONSTRAINT "user_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "daily_metrics_by_company_metrica_dia_empresa_id_idx" ON "public"."daily_metrics_by_company" USING "btree" ("metrica_dia", "empresa_id");



CREATE INDEX "idx_api_keys_wa_me_key" ON "public"."api_keys" USING "btree" ("wa_me_key");



CREATE INDEX "idx_clientes_uuid_identificador" ON "public"."clientes" USING "btree" ("uuid_identificador");



CREATE INDEX "idx_contratos_banco" ON "public"."contratos" USING "btree" ("banco");



CREATE INDEX "idx_contratos_cliente_id" ON "public"."contratos" USING "btree" ("cliente_id");



CREATE INDEX "idx_contratos_created_at" ON "public"."contratos" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_contratos_status" ON "public"."contratos" USING "btree" ("status");



CREATE INDEX "idx_contratos_telefone" ON "public"."contratos" USING "btree" ("telefone");



CREATE INDEX "idx_eventos_empresa_data" ON "public"."eventos" USING "btree" ("empresa_id", "data_evento");



CREATE INDEX "idx_funcionamento_empresa_dia" ON "public"."periodos_funcionamento" USING "btree" ("empresa_id", "dia_semana");



CREATE INDEX "idx_invocations_empresa_agente_data" ON "public"."agent_invocations" USING "btree" ("empresa_id", "nome_agente", "created_at");



CREATE INDEX "idx_prompt_empresa_tipo" ON "public"."prompt" USING "btree" ("empresa", "tipo_prompt");



CREATE OR REPLACE TRIGGER "contratos_updated_at" BEFORE UPDATE ON "public"."contratos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "on_client_update_protect_columns" BEFORE UPDATE ON "public"."clientes" FOR EACH ROW EXECUTE FUNCTION "public"."protect_critical_client_columns"();



CREATE OR REPLACE TRIGGER "on_empresa_created" AFTER INSERT ON "public"."empresa" FOR EACH ROW EXECUTE FUNCTION "public"."criar_pastas_de_empresa"();



CREATE OR REPLACE TRIGGER "on_eventos_change" AFTER INSERT OR DELETE OR UPDATE ON "public"."eventos" FOR EACH ROW EXECUTE FUNCTION "public"."chamar_update_event_prompt"();



CREATE OR REPLACE TRIGGER "on_funcionamento_change" AFTER INSERT OR DELETE OR UPDATE ON "public"."periodos_funcionamento" FOR EACH ROW EXECUTE FUNCTION "public"."atualizar_prompts_de_funcionamento"();



CREATE OR REPLACE TRIGGER "on_functions_change" AFTER INSERT OR DELETE OR UPDATE ON "public"."functions" FOR EACH ROW EXECUTE FUNCTION "public"."atualizar_tools_no_prompt"();



CREATE OR REPLACE TRIGGER "on_new_chatszap_for_testing" AFTER INSERT ON "public"."chatsZap" FOR EACH ROW WHEN (("new"."empresa_id" IS NOT NULL)) EXECUTE FUNCTION "public"."trigger_chamar_teste_responses_api"();



CREATE OR REPLACE TRIGGER "on_update_prompt" BEFORE INSERT OR UPDATE OF "prompt_base", "funcionamento", "datas_especiais", "eventos", "instrucao_inicial" ON "public"."prompt" FOR EACH ROW EXECUTE FUNCTION "public"."atualizar_prompt_completo"();



CREATE OR REPLACE TRIGGER "trigger_agregacao_chatszap" AFTER INSERT ON "public"."chatsZap" FOR EACH ROW EXECUTE FUNCTION "public"."agregar_mensagem_chatszapschedule"();



ALTER TABLE ONLY "public"."agent_invocations"
    ADD CONSTRAINT "agent_invocations_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_invocations"
    ADD CONSTRAINT "agent_invocations_compelition_id_fkey" FOREIGN KEY ("compelition_id") REFERENCES "public"."compelition"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_invocations"
    ADD CONSTRAINT "agent_invocations_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."analytics_aggregates"
    ADD CONSTRAINT "analytics_aggregates_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chatsZap"
    ADD CONSTRAINT "chatsZap_clientes_id_fkey" FOREIGN KEY ("clientes_id") REFERENCES "public"."clientes"("id") ON UPDATE RESTRICT ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chatsZap"
    ADD CONSTRAINT "chatsZap_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON UPDATE RESTRICT ON DELETE SET NULL;



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_atendido_por_fkey" FOREIGN KEY ("atendido_por") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_modificado_por_fkey" FOREIGN KEY ("modificado_por") REFERENCES "public"."user"("id");



ALTER TABLE ONLY "public"."clientes"
    ADD CONSTRAINT "clientes_ultimoChatZap_fkey" FOREIGN KEY ("ultimoChatZap") REFERENCES "public"."chatsZap"("id") ON UPDATE RESTRICT ON DELETE SET NULL;



ALTER TABLE ONLY "public"."compelition"
    ADD CONSTRAINT "compelition_cliente_fkey" FOREIGN KEY ("cliente") REFERENCES "public"."clientes"("id") ON UPDATE RESTRICT ON DELETE CASCADE;



ALTER TABLE ONLY "public"."compelition"
    ADD CONSTRAINT "compelition_empresa_fkey" FOREIGN KEY ("empresa") REFERENCES "public"."empresa"("id") ON UPDATE RESTRICT ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contratos"
    ADD CONSTRAINT "contratos_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id");



ALTER TABLE ONLY "public"."datas_excecao_reserva"
    ADD CONSTRAINT "datas_excecao_reserva_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."empresa"
    ADD CONSTRAINT "empresa_adm_fkey" FOREIGN KEY ("adm") REFERENCES "public"."user"("id") ON UPDATE RESTRICT ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."empresa"
    ADD CONSTRAINT "empresa_modificadoPor_fkey" FOREIGN KEY ("modificadoPor") REFERENCES "public"."user"("id") ON UPDATE RESTRICT ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."eventos"
    ADD CONSTRAINT "eventos_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."functions"
    ADD CONSTRAINT "functions_empresa_fkey" FOREIGN KEY ("empresa") REFERENCES "public"."empresa"("id") ON UPDATE RESTRICT ON DELETE CASCADE;



ALTER TABLE ONLY "public"."functions"
    ADD CONSTRAINT "functions_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompt"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."periodos_funcionamento"
    ADD CONSTRAINT "periodos_funcionamento_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prompt"
    ADD CONSTRAINT "prompt_empresa_fkey" FOREIGN KEY ("empresa") REFERENCES "public"."empresa"("id") ON UPDATE RESTRICT ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prompt_reserva"
    ADD CONSTRAINT "prompt_reserva_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."regras_de_reserva"
    ADD CONSTRAINT "regras_de_reserva_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservas"
    ADD CONSTRAINT "reservas_clientes_id_fkey" FOREIGN KEY ("clientes_id") REFERENCES "public"."clientes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservas"
    ADD CONSTRAINT "reservas_criada_por_fkey" FOREIGN KEY ("criada_por") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reservas"
    ADD CONSTRAINT "reservas_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresa"("id") ON DELETE SET NULL;



CREATE POLICY "Funcionários de portaria podem atualizar reservas" ON "public"."reservas" FOR UPDATE TO "authenticated" USING (("empresa_id" = "public"."get_my_empresa_id"())) WITH CHECK (("empresa_id" = "public"."get_my_empresa_id"()));



CREATE POLICY "Funcionários podem criar reservas para sua empresa" ON "public"."reservas" FOR INSERT TO "authenticated" WITH CHECK (("empresa_id" = "public"."get_my_empresa_id"()));



CREATE POLICY "Funcionários podem ver reservas da sua empresa" ON "public"."reservas" FOR SELECT TO "authenticated" USING (("empresa_id" = "public"."get_my_empresa_id"()));



CREATE POLICY "Gerentes podem apagar reservas" ON "public"."reservas" FOR DELETE TO "authenticated" USING ((("empresa_id" = "public"."get_my_empresa_id"()) AND "public"."usuario_tem_permissao_de"('gerente'::"public"."app_role")));



CREATE POLICY "Gerentes podem atualizar chaves da sua empresa" ON "public"."api_keys" FOR UPDATE TO "authenticated" USING (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"())));



CREATE POLICY "Gerentes podem inserir chaves da sua empresa" ON "public"."api_keys" FOR INSERT TO "authenticated" WITH CHECK (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"())));



CREATE POLICY "Nenhum usuário pode modificar o histórico diretamente" ON "public"."compelition" USING (false);



CREATE POLICY "Ninguém pode ver as chaves diretamente" ON "public"."api_keys" FOR SELECT USING (false);



CREATE POLICY "Permitir gerentes gerenciar eventos da sua empresa" ON "public"."eventos" TO "authenticated" USING (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"()))) WITH CHECK (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"())));



CREATE POLICY "Permitir gerentes gerenciar o funcionamento da sua empresa" ON "public"."periodos_funcionamento" TO "authenticated" USING (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"()))) WITH CHECK (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"())));



CREATE POLICY "Permitir gerentes gerenciar suas regras de reserva" ON "public"."prompt_reserva" FOR UPDATE TO "authenticated" USING (("public"."usuario_tem_permissao_de"('gerente'::"public"."app_role") AND ("empresa_id" = "public"."get_my_empresa_id"())));



CREATE POLICY "Permitir leitura pública das regras de reserva" ON "public"."prompt_reserva" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Permitir leitura pública de eventos" ON "public"."eventos" FOR SELECT USING (true);



CREATE POLICY "Permitir leitura pública do funcionamento" ON "public"."periodos_funcionamento" FOR SELECT USING (("ativo" = true));



CREATE POLICY "Permitir todas operações" ON "public"."contratos" USING (true) WITH CHECK (true);



CREATE POLICY "Superusuários podem criar e apagar empresas" ON "public"."empresa" USING ("public"."usuario_tem_permissao_de"('dev'::"public"."app_role")) WITH CHECK ("public"."usuario_tem_permissao_de"('dev'::"public"."app_role"));



CREATE POLICY "Usuários podem ver e atualizar o seu próprio perfil." ON "public"."profiles" USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contratos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eventos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."functions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."periodos_funcionamento" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prompt_reserva" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reservas" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


SET SESSION AUTHORIZATION "postgres";
RESET SESSION AUTHORIZATION;






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";







































































































































































































































GRANT ALL ON FUNCTION "public"."agregar_mensagem_chatszap"() TO "anon";
GRANT ALL ON FUNCTION "public"."agregar_mensagem_chatszap"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."agregar_mensagem_chatszap"() TO "service_role";



GRANT ALL ON FUNCTION "public"."agregar_mensagem_chatszapschedule"() TO "anon";
GRANT ALL ON FUNCTION "public"."agregar_mensagem_chatszapschedule"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."agregar_mensagem_chatszapschedule"() TO "service_role";



GRANT ALL ON FUNCTION "public"."append_to_compelition_chat"("p_cliente_id" bigint, "p_new_message" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."append_to_compelition_chat"("p_cliente_id" bigint, "p_new_message" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."append_to_compelition_chat"("p_cliente_id" bigint, "p_new_message" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."atribuir_mesa_e_notificar_cliente"("p_reserva_id" bigint, "p_numero_mesa" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."atribuir_mesa_e_notificar_cliente"("p_reserva_id" bigint, "p_numero_mesa" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."atribuir_mesa_e_notificar_cliente"("p_reserva_id" bigint, "p_numero_mesa" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."atualizar_limite_periodo"("p_empresa_id" bigint, "p_nome_periodo" "text", "p_limite_maximo" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."atualizar_limite_periodo"("p_empresa_id" bigint, "p_nome_periodo" "text", "p_limite_maximo" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."atualizar_limite_periodo"("p_empresa_id" bigint, "p_nome_periodo" "text", "p_limite_maximo" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."atualizar_prompt_completo"() TO "anon";
GRANT ALL ON FUNCTION "public"."atualizar_prompt_completo"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."atualizar_prompt_completo"() TO "service_role";



GRANT ALL ON FUNCTION "public"."atualizar_prompts_de_funcionamento"() TO "anon";
GRANT ALL ON FUNCTION "public"."atualizar_prompts_de_funcionamento"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."atualizar_prompts_de_funcionamento"() TO "service_role";



GRANT ALL ON FUNCTION "public"."atualizar_tools_no_prompt"() TO "anon";
GRANT ALL ON FUNCTION "public"."atualizar_tools_no_prompt"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."atualizar_tools_no_prompt"() TO "service_role";



GRANT ALL ON FUNCTION "public"."block_self_role_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."block_self_role_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_self_role_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."bloqueio_ia_cliente"("p_cliente_id" bigint, "p_suspender_permanentemente" boolean, "p_reativar" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."bloqueio_ia_cliente"("p_cliente_id" bigint, "p_suspender_permanentemente" boolean, "p_reativar" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bloqueio_ia_cliente"("p_cliente_id" bigint, "p_suspender_permanentemente" boolean, "p_reativar" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."buscar_contrato"("p_telefone" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."buscar_contrato"("p_telefone" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."buscar_contrato"("p_telefone" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."buscar_reserva_ativa_cliente"("p_cliente_uuid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."buscar_reserva_ativa_cliente"("p_cliente_uuid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."buscar_reserva_ativa_cliente"("p_cliente_uuid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."chamar_update_event_prompt"() TO "anon";
GRANT ALL ON FUNCTION "public"."chamar_update_event_prompt"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."chamar_update_event_prompt"() TO "service_role";



GRANT ALL ON FUNCTION "public"."confirmar_reserva"("p_reserva_id" bigint, "p_cancelar" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."confirmar_reserva"("p_reserva_id" bigint, "p_cancelar" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirmar_reserva"("p_reserva_id" bigint, "p_cancelar" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."criar_pastas_de_empresa"() TO "anon";
GRANT ALL ON FUNCTION "public"."criar_pastas_de_empresa"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."criar_pastas_de_empresa"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enviar_cliente_xano"("p_cliente_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."enviar_cliente_xano"("p_cliente_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."enviar_cliente_xano"("p_cliente_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."enviar_lembrete_confirmacao"("p_tipo_lembrete" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."enviar_lembrete_confirmacao"("p_tipo_lembrete" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."enviar_lembrete_confirmacao"("p_tipo_lembrete" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."gerenciar_confirmacao_reserva"("p_reserva_id" bigint, "p_confirmada" boolean, "p_ressalva" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."gerenciar_confirmacao_reserva"("p_reserva_id" bigint, "p_confirmada" boolean, "p_ressalva" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gerenciar_confirmacao_reserva"("p_reserva_id" bigint, "p_confirmada" boolean, "p_ressalva" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_chat_history"("p_chat_id" "text", "p_instancia" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_chat_history"("p_chat_id" "text", "p_instancia" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_chat_history"("p_chat_id" "text", "p_instancia" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_chat_list"("p_empresa_id" bigint, "p_page_size" integer, "p_page_number" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_chat_list"("p_empresa_id" bigint, "p_page_size" integer, "p_page_number" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_chat_list"("p_empresa_id" bigint, "p_page_size" integer, "p_page_number" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_company_settings"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_company_settings"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_company_settings"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_confirmation_context"("p_empresa_id" bigint, "p_data" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_confirmation_context"("p_empresa_id" bigint, "p_data" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_confirmation_context"("p_empresa_id" bigint, "p_data" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_dashboard_analytics"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_dashboard_analytics"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_analytics"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_equipa_da_empresa"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_equipa_da_empresa"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_equipa_da_empresa"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_empresa_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_empresa_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_empresa_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_pending_confirmations"("p_empresa_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."get_pending_confirmations"("p_empresa_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pending_confirmations"("p_empresa_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_reservations_for_day"("p_empresa_id" bigint, "p_data" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_reservations_for_day"("p_empresa_id" bigint, "p_data" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_reservations_for_day"("p_empresa_id" bigint, "p_data" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_reservations_summary"("p_empresa_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."get_reservations_summary"("p_empresa_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_reservations_summary"("p_empresa_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."limpeza_diaria_sistema"() TO "anon";
GRANT ALL ON FUNCTION "public"."limpeza_diaria_sistema"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."limpeza_diaria_sistema"() TO "service_role";



GRANT ALL ON FUNCTION "public"."marcar_reserva_como_confirmada"("p_cliente_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."marcar_reserva_como_confirmada"("p_cliente_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."marcar_reserva_como_confirmada"("p_cliente_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."nome_da_sua_funcao"() TO "anon";
GRANT ALL ON FUNCTION "public"."nome_da_sua_funcao"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."nome_da_sua_funcao"() TO "service_role";



GRANT ALL ON FUNCTION "public"."processar_cliente_especifico"("p_cliente_id" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."processar_cliente_especifico"("p_cliente_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."processar_cliente_especifico"("p_cliente_id" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."processar_clientes_agendados"() TO "anon";
GRANT ALL ON FUNCTION "public"."processar_clientes_agendados"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."processar_clientes_agendados"() TO "service_role";



GRANT ALL ON FUNCTION "public"."processar_e_arquivar_mensagem"("p_cliente_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."processar_e_arquivar_mensagem"("p_cliente_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."processar_e_arquivar_mensagem"("p_cliente_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."processar_e_arquivar_teste_espelho"("p_compelition_id_producao" bigint, "p_mensagem_agregada" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."processar_e_arquivar_teste_espelho"("p_compelition_id_producao" bigint, "p_mensagem_agregada" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."processar_e_arquivar_teste_espelho"("p_compelition_id_producao" bigint, "p_mensagem_agregada" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."promover_usuario"("p_alvo_id" "uuid", "p_novo_cargo" "public"."app_role") TO "anon";
GRANT ALL ON FUNCTION "public"."promover_usuario"("p_alvo_id" "uuid", "p_novo_cargo" "public"."app_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."promover_usuario"("p_alvo_id" "uuid", "p_novo_cargo" "public"."app_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_critical_client_columns"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_critical_client_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_critical_client_columns"() TO "service_role";



GRANT ALL ON FUNCTION "public"."testar_leitura_secret"("p_secret_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."testar_leitura_secret"("p_secret_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."testar_leitura_secret"("p_secret_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_chamar_teste_responses_api"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_chamar_teste_responses_api"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_chamar_teste_responses_api"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_analytics_aggregates"("p_data_referencia" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."update_analytics_aggregates"("p_data_referencia" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_analytics_aggregates"("p_data_referencia" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_contrato"("p_telefone" "text", "p_cliente_id" bigint, "p_nome" "text", "p_nome_pai" "text", "p_nome_mae" "text", "p_numero_contrato" "text", "p_banco" "text", "p_parcelas" integer, "p_valor_parcela" numeric, "p_prazo_contrato" integer, "p_parcelas_pagas" integer, "p_parcelas_em_aberto" integer, "p_parcelas_atrasadas" integer, "p_valor_estimado_quitacao" numeric, "p_percentual_desconto" numeric, "p_status" "text", "p_observacoes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_contrato"("p_telefone" "text", "p_cliente_id" bigint, "p_nome" "text", "p_nome_pai" "text", "p_nome_mae" "text", "p_numero_contrato" "text", "p_banco" "text", "p_parcelas" integer, "p_valor_parcela" numeric, "p_prazo_contrato" integer, "p_parcelas_pagas" integer, "p_parcelas_em_aberto" integer, "p_parcelas_atrasadas" integer, "p_valor_estimado_quitacao" numeric, "p_percentual_desconto" numeric, "p_status" "text", "p_observacoes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_contrato"("p_telefone" "text", "p_cliente_id" bigint, "p_nome" "text", "p_nome_pai" "text", "p_nome_mae" "text", "p_numero_contrato" "text", "p_banco" "text", "p_parcelas" integer, "p_valor_parcela" numeric, "p_prazo_contrato" integer, "p_parcelas_pagas" integer, "p_parcelas_em_aberto" integer, "p_parcelas_atrasadas" integer, "p_valor_estimado_quitacao" numeric, "p_percentual_desconto" numeric, "p_status" "text", "p_observacoes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."usuario_tem_permissao_de"("p_role_requerida" "public"."app_role") TO "anon";
GRANT ALL ON FUNCTION "public"."usuario_tem_permissao_de"("p_role_requerida" "public"."app_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."usuario_tem_permissao_de"("p_role_requerida" "public"."app_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."verificar_disponibilidade"("p_cliente_uuid" "uuid", "p_data_desejada" "date", "p_nome_periodo" "text", "p_numero_de_pessoas" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."verificar_disponibilidade"("p_cliente_uuid" "uuid", "p_data_desejada" "date", "p_nome_periodo" "text", "p_numero_de_pessoas" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."verificar_disponibilidade"("p_cliente_uuid" "uuid", "p_data_desejada" "date", "p_nome_periodo" "text", "p_numero_de_pessoas" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."verificar_permissao_usuario"("p_user_id" "uuid", "p_role_requerida" "public"."app_role") TO "anon";
GRANT ALL ON FUNCTION "public"."verificar_permissao_usuario"("p_user_id" "uuid", "p_role_requerida" "public"."app_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verificar_permissao_usuario"("p_user_id" "uuid", "p_role_requerida" "public"."app_role") TO "service_role";
























GRANT ALL ON TABLE "public"."agent_invocations" TO "anon";
GRANT ALL ON TABLE "public"."agent_invocations" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_invocations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agent_invocations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agent_invocations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agent_invocations_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."analytics_aggregates" TO "anon";
GRANT ALL ON TABLE "public"."analytics_aggregates" TO "authenticated";
GRANT ALL ON TABLE "public"."analytics_aggregates" TO "service_role";



GRANT ALL ON SEQUENCE "public"."analytics_aggregates_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."analytics_aggregates_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."analytics_aggregates_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."api_keys" TO "anon";
GRANT ALL ON TABLE "public"."api_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."api_keys" TO "service_role";



GRANT ALL ON SEQUENCE "public"."api_keys_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."api_keys_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."api_keys_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."chatsZap" TO "anon";
GRANT ALL ON TABLE "public"."chatsZap" TO "authenticated";
GRANT ALL ON TABLE "public"."chatsZap" TO "service_role";



GRANT ALL ON SEQUENCE "public"."chatsZap_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."chatsZap_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."chatsZap_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."clientes" TO "anon";
GRANT ALL ON TABLE "public"."clientes" TO "authenticated";
GRANT ALL ON TABLE "public"."clientes" TO "service_role";



GRANT ALL ON TABLE "public"."reservas" TO "anon";
GRANT ALL ON TABLE "public"."reservas" TO "authenticated";
GRANT ALL ON TABLE "public"."reservas" TO "service_role";



GRANT ALL ON TABLE "public"."clientes_com_reserva_ativa" TO "anon";
GRANT ALL ON TABLE "public"."clientes_com_reserva_ativa" TO "authenticated";
GRANT ALL ON TABLE "public"."clientes_com_reserva_ativa" TO "service_role";



GRANT ALL ON SEQUENCE "public"."clientes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."clientes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."clientes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."compelition" TO "anon";
GRANT ALL ON TABLE "public"."compelition" TO "authenticated";
GRANT ALL ON TABLE "public"."compelition" TO "service_role";



GRANT ALL ON SEQUENCE "public"."compelitionsd_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."compelitionsd_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."compelitionsd_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contratos" TO "anon";
GRANT ALL ON TABLE "public"."contratos" TO "authenticated";
GRANT ALL ON TABLE "public"."contratos" TO "service_role";



GRANT ALL ON TABLE "public"."convites_beta" TO "anon";
GRANT ALL ON TABLE "public"."convites_beta" TO "authenticated";
GRANT ALL ON TABLE "public"."convites_beta" TO "service_role";



GRANT ALL ON SEQUENCE "public"."convites_beta_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."convites_beta_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."convites_beta_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."dados_do_cliente" TO "anon";
GRANT ALL ON TABLE "public"."dados_do_cliente" TO "authenticated";
GRANT ALL ON TABLE "public"."dados_do_cliente" TO "service_role";



GRANT ALL ON TABLE "public"."daily_metrics_by_company" TO "anon";
GRANT ALL ON TABLE "public"."daily_metrics_by_company" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_metrics_by_company" TO "service_role";



GRANT ALL ON TABLE "public"."datas_excecao_reserva" TO "anon";
GRANT ALL ON TABLE "public"."datas_excecao_reserva" TO "authenticated";
GRANT ALL ON TABLE "public"."datas_excecao_reserva" TO "service_role";



GRANT ALL ON SEQUENCE "public"."datas_excecao_reserva_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."datas_excecao_reserva_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."datas_excecao_reserva_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."empresa" TO "anon";
GRANT ALL ON TABLE "public"."empresa" TO "authenticated";
GRANT ALL ON TABLE "public"."empresa" TO "service_role";



GRANT ALL ON SEQUENCE "public"."empresa_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."empresa_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."empresa_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."eventos" TO "anon";
GRANT ALL ON TABLE "public"."eventos" TO "authenticated";
GRANT ALL ON TABLE "public"."eventos" TO "service_role";



GRANT ALL ON SEQUENCE "public"."eventos_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."eventos_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."eventos_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."functions" TO "anon";
GRANT ALL ON TABLE "public"."functions" TO "authenticated";
GRANT ALL ON TABLE "public"."functions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."functions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."functions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."functions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."periodos_funcionamento" TO "anon";
GRANT ALL ON TABLE "public"."periodos_funcionamento" TO "authenticated";
GRANT ALL ON TABLE "public"."periodos_funcionamento" TO "service_role";



GRANT ALL ON SEQUENCE "public"."periodos_funcionamento_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."periodos_funcionamento_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."periodos_funcionamento_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."prompt" TO "anon";
GRANT ALL ON TABLE "public"."prompt" TO "authenticated";
GRANT ALL ON TABLE "public"."prompt" TO "service_role";



GRANT ALL ON SEQUENCE "public"."prompt_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."prompt_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."prompt_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."prompt_reserva" TO "anon";
GRANT ALL ON TABLE "public"."prompt_reserva" TO "authenticated";
GRANT ALL ON TABLE "public"."prompt_reserva" TO "service_role";



GRANT ALL ON SEQUENCE "public"."prompt_reserva_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."prompt_reserva_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."prompt_reserva_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."regras_de_reserva" TO "anon";
GRANT ALL ON TABLE "public"."regras_de_reserva" TO "authenticated";
GRANT ALL ON TABLE "public"."regras_de_reserva" TO "service_role";



GRANT ALL ON SEQUENCE "public"."regras_de_reserva_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."regras_de_reserva_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."regras_de_reserva_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."reservas_futuras" TO "anon";
GRANT ALL ON TABLE "public"."reservas_futuras" TO "authenticated";
GRANT ALL ON TABLE "public"."reservas_futuras" TO "service_role";



GRANT ALL ON SEQUENCE "public"."reservas_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."reservas_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."reservas_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."resumo_reservas_diarias" TO "anon";
GRANT ALL ON TABLE "public"."resumo_reservas_diarias" TO "authenticated";
GRANT ALL ON TABLE "public"."resumo_reservas_diarias" TO "service_role";



GRANT ALL ON TABLE "public"."solicitacoes_de_convite" TO "anon";
GRANT ALL ON TABLE "public"."solicitacoes_de_convite" TO "authenticated";
GRANT ALL ON TABLE "public"."solicitacoes_de_convite" TO "service_role";



GRANT ALL ON SEQUENCE "public"."solicitacoes_de_convite_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."solicitacoes_de_convite_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."solicitacoes_de_convite_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user" TO "anon";
GRANT ALL ON TABLE "public"."user" TO "authenticated";
GRANT ALL ON TABLE "public"."user" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."v_debug_mode" TO "anon";
GRANT ALL ON TABLE "public"."v_debug_mode" TO "authenticated";
GRANT ALL ON TABLE "public"."v_debug_mode" TO "service_role";



GRANT ALL ON TABLE "public"."view_leads_resumo" TO "anon";
GRANT ALL ON TABLE "public"."view_leads_resumo" TO "authenticated";
GRANT ALL ON TABLE "public"."view_leads_resumo" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






























RESET ALL;
