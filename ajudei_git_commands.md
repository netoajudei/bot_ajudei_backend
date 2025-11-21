# Guia Completo: Comandos Supabase + Git - Projeto Ajudei

## 🚀 PARTE 1: SUPABASE CLI

### 1. Verificar e Configurar Supabase
```bash
# Verificar versão instalada
supabase --version

# Fazer login no Supabase
supabase login

# Fazer logout (trocar conta)
supabase logout
```

### 2. Gerenciar Projetos
```bash
# Listar todos os projetos
supabase projects list

# Vincular projeto local ao remoto (Ajudei)
supabase link --project-ref ctsvfluufyfhkqlonqio
```

### 3. Backup da Estrutura do Banco
```bash
# Exportar estrutura do banco (sem dados)
supabase db dump --linked -f ajudeiv1.sql

# Exportar com data de versão
supabase db dump --linked -f ajudei_backup_$(date +%Y-%m-%d).sql
```

### 4. Gerenciar Edge Functions
```bash
# Listar todas as Edge Functions
supabase functions list --project-ref ctsvfluufyfhkqlonqio

# Baixar TODAS as Edge Functions (40 functions)
# Copie e cole todos estes comandos no terminal de uma vez:

supabase functions download waapi-webhook --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-message-handler --project-ref ctsvfluufyfhkqlonqio
supabase functions download gemini-compelition --project-ref ctsvfluufyfhkqlonqio
supabase functions download send-whatsapp-message --project-ref ctsvfluufyfhkqlonqio
supabase functions download create-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download cancel-reservation-client --project-ref ctsvfluufyfhkqlonqio
supabase functions download edit-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download validate-and-find-client --project-ref ctsvfluufyfhkqlonqio
supabase functions download manual-create-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download create-invite --project-ref ctsvfluufyfhkqlonqio
supabase functions download assign-table --project-ref ctsvfluufyfhkqlonqio
supabase functions download manual-cancel-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download execute-cardapio-tool --project-ref ctsvfluufyfhkqlonqio
supabase functions download recrutamento --project-ref ctsvfluufyfhkqlonqio
supabase functions download consultar_agenda --project-ref ctsvfluufyfhkqlonqio
supabase functions download atualiza_evento --project-ref ctsvfluufyfhkqlonqio
supabase functions download inviteUserByEmail --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook_testes --project-ref ctsvfluufyfhkqlonqio
supabase functions download gemini-compelition-teste --project-ref ctsvfluufyfhkqlonqio
supabase functions download agente-roteador --project-ref ctsvfluufyfhkqlonqio
supabase functions download create-reserva-com-regras --project-ref ctsvfluufyfhkqlonqio
supabase functions download recrutamento-especialista --project-ref ctsvfluufyfhkqlonqio
supabase functions download novos-parceiros --project-ref ctsvfluufyfhkqlonqio
supabase functions download atendimento-humano --project-ref ctsvfluufyfhkqlonqio
supabase functions download migra_clientes_xano --project-ref ctsvfluufyfhkqlonqio
supabase functions download send_whats_wame --project-ref ctsvfluufyfhkqlonqio
supabase functions download send-whatsapp-gateway --project-ref ctsvfluufyfhkqlonqio
supabase functions download feedback-gateway --project-ref ctsvfluufyfhkqlonqio
supabase functions download criar-reserva-link --project-ref ctsvfluufyfhkqlonqio
supabase functions download orquestrador-com-link-dinamico --project-ref ctsvfluufyfhkqlonqio
supabase functions download gerenciar-reserva-link --project-ref ctsvfluufyfhkqlonqio
supabase functions download solicitar-edicao-reserva-link --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-api-wa-me2 --project-ref ctsvfluufyfhkqlonqio
supabase functions download teste_responses_api --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-api-oficial --project-ref ctsvfluufyfhkqlonqio
supabase functions download transcrever-audio --project-ref ctsvfluufyfhkqlonqio
supabase functions download enviar-link-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download orquestrador-conversation --project-ref ctsvfluufyfhkqlonqio
supabase functions download finalizar-tool-conversation --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-api-wa-me3 --project-ref ctsvfluufyfhkqlonqio
```

---

## 📁 PARTE 2: GIT E GITHUB

### 1. Configurar Git (Primeira Vez)
```bash
# Configurar nome de usuário
git config --global user.name "netoajudei"

# Configurar email
git config --global user.email "seu_email@exemplo.com"

# Ver configuração atual
git config --global user.name
git config --global user.email
```

### 2. Inicializar Repositório Local
```bash
# Entrar na pasta do projeto
cd /caminho/para/pasta/ajudei

# Inicializar Git
git init

# Adicionar todos os arquivos
git add .

# Fazer primeiro commit
git commit -m "Backup inicial do projeto Ajudei"
```

### 3. Conectar ao GitHub
```bash
# Conectar ao repositório GitHub (HTTPS)
git remote add origin https://github.com/netoajudei/bot_ajudei_backend.git

# Conectar ao repositório GitHub (SSH)
git remote add origin git@github.com:netoajudei/bot_ajudei_backend.git

# Verificar conexão
git remote -v

# Remover conexão (caso precise trocar)
git remote remove origin
```

### 4. Enviar para GitHub
```bash
# Primeiro push (criar branch main)
git push -u origin main

# Pushes subsequentes
git push
```

### 5. Workflow de Atualizações
```bash
# 1. Ver status dos arquivos
git status

# 2. Adicionar arquivos modificados
git add .

# 3. Fazer commit com mensagem descritiva
git commit -m "Descrição das mudanças"

# 4. Enviar para GitHub
git push
```

---

## 🔄 FLUXO COMPLETO DE BACKUP - PROJETO AJUDEI

### Cenário: Backup Completo do Bot Ajudei

```bash
# 1. Entrar na pasta do projeto
cd pasta_backup_ajudei

# 2. Fazer login no Supabase
supabase login

# 3. Listar projetos (verificar)
supabase projects list

# 4. Vincular projeto Ajudei
supabase link --project-ref ctsvfluufyfhkqlonqio

# 5. Exportar estrutura do banco
supabase db dump --linked -f ajudeiv1.sql

# 6. Criar pasta para functions (se não existir)
mkdir -p edge_functions

# 7. Listar Edge Functions
supabase functions list --project-ref ctsvfluufyfhkqlonqio

# 8. Baixar TODAS as Edge Functions (copie e cole o bloco completo)
supabase functions download waapi-webhook --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-message-handler --project-ref ctsvfluufyfhkqlonqio
supabase functions download gemini-compelition --project-ref ctsvfluufyfhkqlonqio
supabase functions download send-whatsapp-message --project-ref ctsvfluufyfhkqlonqio
supabase functions download create-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download cancel-reservation-client --project-ref ctsvfluufyfhkqlonqio
supabase functions download edit-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download validate-and-find-client --project-ref ctsvfluufyfhkqlonqio
supabase functions download manual-create-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download create-invite --project-ref ctsvfluufyfhkqlonqio
supabase functions download assign-table --project-ref ctsvfluufyfhkqlonqio
supabase functions download manual-cancel-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download execute-cardapio-tool --project-ref ctsvfluufyfhkqlonqio
supabase functions download recrutamento --project-ref ctsvfluufyfhkqlonqio
supabase functions download consultar_agenda --project-ref ctsvfluufyfhkqlonqio
supabase functions download atualiza_evento --project-ref ctsvfluufyfhkqlonqio
supabase functions download inviteUserByEmail --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook_testes --project-ref ctsvfluufyfhkqlonqio
supabase functions download gemini-compelition-teste --project-ref ctsvfluufyfhkqlonqio
supabase functions download agente-roteador --project-ref ctsvfluufyfhkqlonqio
supabase functions download create-reserva-com-regras --project-ref ctsvfluufyfhkqlonqio
supabase functions download recrutamento-especialista --project-ref ctsvfluufyfhkqlonqio
supabase functions download novos-parceiros --project-ref ctsvfluufyfhkqlonqio
supabase functions download atendimento-humano --project-ref ctsvfluufyfhkqlonqio
supabase functions download migra_clientes_xano --project-ref ctsvfluufyfhkqlonqio
supabase functions download send_whats_wame --project-ref ctsvfluufyfhkqlonqio
supabase functions download send-whatsapp-gateway --project-ref ctsvfluufyfhkqlonqio
supabase functions download feedback-gateway --project-ref ctsvfluufyfhkqlonqio
supabase functions download criar-reserva-link --project-ref ctsvfluufyfhkqlonqio
supabase functions download orquestrador-com-link-dinamico --project-ref ctsvfluufyfhkqlonqio
supabase functions download gerenciar-reserva-link --project-ref ctsvfluufyfhkqlonqio
supabase functions download solicitar-edicao-reserva-link --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-api-wa-me2 --project-ref ctsvfluufyfhkqlonqio
supabase functions download teste_responses_api --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-api-oficial --project-ref ctsvfluufyfhkqlonqio
supabase functions download transcrever-audio --project-ref ctsvfluufyfhkqlonqio
supabase functions download enviar-link-reserva --project-ref ctsvfluufyfhkqlonqio
supabase functions download orquestrador-conversation --project-ref ctsvfluufyfhkqlonqio
supabase functions download finalizar-tool-conversation --project-ref ctsvfluufyfhkqlonqio
supabase functions download webhook-api-wa-me3 --project-ref ctsvfluufyfhkqlonqio

# 9. Inicializar Git (se ainda não foi feito)
git init

# 10. Adicionar tudo
git add .

# 11. Fazer commit
git commit -m "Backup completo Ajudei - DB structure + Edge Functions"

# 12. Conectar ao GitHub (se ainda não foi feito)
git remote add origin https://github.com/netoajudei/bot_ajudei_backend.git

# 13. Enviar para GitHub
git push -u origin main
```

---

## 🔧 COMANDOS ÚTEIS EXTRAS

### Git
```bash
# Ver histórico de commits
git log --oneline

# Ver últimos 5 commits
git log --oneline -5

# Voltar para commit anterior
git checkout HASH_DO_COMMIT

# Voltar para a versão mais recente
git checkout main

# Ver diferenças antes do commit
git diff

# Ver diferenças de arquivo específico
git diff nome_do_arquivo.sql

# Desfazer último commit (mantém mudanças)
git reset --soft HEAD~1

# Ver branches
git branch

# Criar nova branch
git checkout -b nome_nova_branch
```

### Supabase
```bash
# Executar com debug (para troubleshooting)
supabase db dump --debug --linked -f ajudeiv1.sql

# Ver ajuda de qualquer comando
supabase help
supabase db dump --help
supabase functions --help

# Verificar status do projeto vinculado
supabase status

# Ver detalhes do projeto
supabase projects list
```

---

## 📋 CHECKLIST DE BACKUP

### Backup Rápido (Apenas estrutura DB)
- [ ] `cd pasta_do_projeto`
- [ ] `supabase login`
- [ ] `supabase link --project-ref ctsvfluufyfhkqlonqio`
- [ ] `supabase db dump --linked -f ajudeiv1.sql`
- [ ] `git add ajudeiv1.sql`
- [ ] `git commit -m "Atualização estrutura DB"`
- [ ] `git push`

### Backup Completo (DB + Functions)
- [ ] `cd pasta_do_projeto`
- [ ] `supabase login`
- [ ] `supabase link --project-ref ctsvfluufyfhkqlonqio`
- [ ] `supabase db dump --linked -f ajudeiv1.sql`
- [ ] `supabase functions list --project-ref ctsvfluufyfhkqlonqio`
- [ ] Baixar todas as Edge Functions
- [ ] `git add .`
- [ ] `git commit -m "Backup completo - DB + Functions"`
- [ ] `git push`

---

## 🚨 NOTAS IMPORTANTES - PROJETO AJUDEI

1. **Project ID**: `ctsvfluufyfhkqlonqio` - sempre use este ID para o projeto Ajudei
2. **Repositório**: `https://github.com/netoajudei/bot_ajudei_backend`
3. **Arquivo SQL**: `ajudeiv1.sql` - nome padrão do dump da estrutura
4. **Personal Access Token**: Use token do GitHub como senha para HTTPS
5. **Backup Regular**: Faça backups após mudanças importantes nas Edge Functions
6. **Edge Functions**: Sempre baixe pelo SLUG, não pelo nome exibido
7. **Mensagens de Commit**: Use mensagens descritivas tipo:
   - "Adicionada função de webhook WhatsApp"
   - "Atualizada estrutura de tabela de mensagens"
   - "Backup mensal - todas functions"

---

## 🔄 ROTINA SUGERIDA DE BACKUP

### Diário (se houver mudanças)
```bash
cd pasta_projeto_ajudei
git add .
git commit -m "Mudanças diárias - [descrever]"
git push
```

### Semanal (estrutura DB)
```bash
cd pasta_projeto_ajudei
supabase db dump --linked -f ajudeiv1.sql
git add ajudeiv1.sql
git commit -m "Backup semanal - estrutura DB"
git push
```

### Mensal (completo)
```bash
cd pasta_projeto_ajudei
supabase db dump --linked -f ajudeiv1_$(date +%Y-%m).sql
# Baixar todas as Edge Functions atualizadas
git add .
git commit -m "Backup mensal completo"
git push
```

---

## 📞 TROUBLESHOOTING

### Erro: "failed to link project"
```bash
# Verificar se está logado
supabase status

# Fazer logout e login novamente
supabase logout
supabase login

# Tentar vincular novamente
supabase link --project-ref ctsvfluufyfhkqlonqio
```

### Erro: "fatal: not a git repository"
```bash
# Inicializar git na pasta
git init
```

### Erro: "remote origin already exists"
```bash
# Remover remote existente
git remote remove origin

# Adicionar novamente
git remote add origin https://github.com/netoajudei/bot_ajudei_backend.git
```

### Erro ao fazer push
```bash
# Puxar mudanças do remoto primeiro
git pull origin main --rebase

# Depois fazer push
git push
```

---

## 🎯 PRÓXIMOS PASSOS

1. **Complete a lista de Edge Functions**: Execute o comando de listar functions e adicione todas as slugs na seção 4
2. **Configure suas credenciais Git**: Se ainda não fez, configure user.name e user.email
3. **Teste o fluxo completo**: Faça um backup teste para verificar se tudo funciona
4. **Documente mudanças específicas**: Anote qualquer peculiaridade do projeto Ajudei que precise ser lembrada

---

**Última atualização**: 21/11/2024
**Mantido por**: @netoajudei
**Projeto**: Bot Ajudei Backend
**Total de Edge Functions**: 40 functions
