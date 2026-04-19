# Setup Meta WhatsApp Cloud API · Instituto Nova Medida

> Passo-a-passo para o operador. Atualizado em **2026-04-19**.

## Status atual (2026-04-19)

✅ App "Instituto Nova Medida" criado em developers.facebook.com
✅ Permissões selecionadas: WhatsApp + API de Marketing
✅ App ID, App Secret e Client Token recebidos
✅ Access Token temporário recebido (24h, gravado em `.env.local`)
✅ **WABA ID + Phone Number ID do TEST NUMBER recebidos e gravados:**
   - `WHATSAPP_BUSINESS_ACCOUNT_ID=3610674345738807`
   - `WHATSAPP_PHONE_NUMBER_ID=1093315577192606`
✅ **Destinatário verificado: +55 21 99885-1851** (chip do operador)
✅ **Pipeline ponta-a-ponta entregando mensagem real no WhatsApp:**
   - Curl direto pra Meta → 🟢 entregue
   - POST /api/lead → lead persistido + WhatsApp 🟢 entregue
   - status='sent' + message_id gravados no Supabase
⚠️ Número `+55 21 99732-2906` **com restrição na Meta** (erro `#2655121`)
   pra usar como REMETENTE — não é bloqueio, estamos usando o test number.

❌ Access Token permanente — só quando formos pra produção
❌ Template `boas_vindas_inicial` em pt_BR — a submeter no WhatsApp Manager
❌ Webhook `/api/wa/webhook` pra receber delivered/read/respostas

---

## Conceitos rápidos

| Termo | O que é | Onde aparece |
|---|---|---|
| **App ID** / **App Secret** | Identificam o aplicativo Meta. Já temos. | Configurações → Básico |
| **Client Token** | Autentica chamadas vindas de apps clientes. Já temos. | Configurações → Avançado |
| **WABA ID** (WhatsApp Business Account ID) | Identifica a conta empresarial WhatsApp. Diferente do App ID. | WhatsApp → Configuração da API |
| **Phone Number ID** | ID interno do número no Meta (não é o número em si). | WhatsApp → Configuração da API |
| **Access Token (Temporário)** | Token de 24h. Bom pra testar. | WhatsApp → Configuração da API |
| **Access Token (Permanente)** | Token que não expira. **Necessário pra produção.** | Business Manager → System User |

---

## Passo 1 · Usar o TEST NUMBER da Meta (nossa rota agora)

Como o número próprio está restrito (#2655121), vamos usar o **número de teste gratuito**
que a Meta cria automaticamente quando você ativa o produto WhatsApp no app.

**Vantagens:**
- ✅ Sem restrição alguma — funciona imediatamente
- ✅ Permite enviar mensagens pra **até 5 destinatários verificados**
- ✅ Suficiente pra todo o desenvolvimento, demos e validação do pipeline
- ✅ Quando o número próprio destravar, basta trocar `WHATSAPP_PHONE_NUMBER_ID`

**Passos:**

1. Vai em **[developers.facebook.com](https://developers.facebook.com)** → app **Instituto Nova Medida**
2. Menu lateral → **Produtos → WhatsApp → Configuração da API**
3. Na seção **"De"** (From), abre o dropdown — vai aparecer **"Número de teste"** (test number)
   já criado automaticamente pela Meta. Algo como `+1 555 0123 456`
4. Selecionando o test number, aparece logo abaixo:
   ```
   De
   ┌────────────────────────────────────────────┐
   │ ▼ Número de teste:  +1 555 0123 456        │
   │   ID do número: 678901234567890            │  ← Phone Number ID (me manda)
   └────────────────────────────────────────────┘

   ID da conta do WhatsApp Business
   ┌────────────────────────────────────────────┐
   │ 109876543210987                            │  ← WABA ID (me manda)
   └────────────────────────────────────────────┘
   ```
5. Na seção **"Para"** (To), clica em **"Gerenciar lista de números"** ou
   **"Adicionar número de telefone"** → cadastra o **+55 21 99732-2906**
   (seu número pessoal, pra você receber a mensagem de teste).
   - A Meta vai enviar SMS/ligar com código de 6 dígitos pra verificar.
   - Pode adicionar até 5 números (sócio, esposa, etc).

**Me manda os 2 IDs (Phone Number ID + WABA ID).** ✅ feito.

---

## Passo 1.5 · Verificar +55 21 99732-2906 como destinatário do test number

Esse é o **único bloqueio** entre a gente e a mensagem chegando no seu
WhatsApp. A Meta exige que destinatários do test number sejam pré-verificados.

1. Vai em **WhatsApp → Configuração da API**
2. Na seção **"Para"** (To) — fica logo abaixo do "De" — clica em
   **"Gerenciar lista de números de telefone"**
3. Clica em **"Adicionar número de telefone"**
4. Insere: **+55 21 99732-2906**
5. Escolhe receber código por SMS ou ligação
6. Cola o código de 6 dígitos que chegou
7. Pronto — número aparece como verificado na lista

A partir desse momento, qualquer mensagem que o servidor mandar pra esse
número via Cloud API vai chegar normalmente no seu WhatsApp.

> Pode adicionar até 5 números (até 5 destinatários verificados é o
> limite do test number). Adicione também outros números que queira
> testar (sócio, esposa, equipe).

---

## Sobre o número próprio (+55 21 99732-2906)

Status: **restrito** (`#2655121:WBxP-783273915-4224144161`)

**Em paralelo, ações que você pode fazer enquanto seguimos com o test number:**

1. **Aguardar 24-72h.** O WhatsApp tem um cooldown depois que você desconecta um número
   do app de celular. Tente registrar de novo dali a 2-3 dias — geralmente destrava sozinho.

2. **Abrir caso no Meta Business Support:**
   - [business.facebook.com/business/help](https://business.facebook.com/business/help) →
     "Entrar em contato com o suporte" → seleciona o app **Instituto Nova Medida**
   - Cole o código do erro: `#2655121:WBxP-783273915-4224144161`
   - Mensagem sugerida (em português):
     > "Olá. Tentei adicionar o número +55 21 99732-2906 à minha conta WhatsApp Business
     > pelo Meta for Developers e recebo o erro #2655121. O número estava previamente
     > registrado no app WhatsApp Business no meu celular e foi apagado. Por favor
     > revisem e liberem a restrição para que eu possa cadastrar o número novamente.
     > Obrigado."
   - SLA típico: 3-15 dias úteis.

3. **Alternativa: usar outro número exclusivo** pra produção (chip novo, R$ 30/mês).
   Esse será o caminho recomendado em produção mesmo, pra isolar o número da empresa
   do número pessoal.

---

## Passo 2 · Token Temporário (24h) — pra começar a testar

✅ **Já recebido em 2026-04-19** — gravado em `.env.local` como `WHATSAPP_ACCESS_TOKEN`.

Esse token vale 24h. Se vencer antes de gerarmos o permanente, basta voltar em
**WhatsApp → Configuração da API** e clicar em "Gerar token" de novo.

---

## Passo 3 · Token Permanente — pra produção (faremos depois)

Tokens permanentes são gerados via **System User** no Business Manager. É um processo de ~5 minutos:

1. Vai em **[business.facebook.com](https://business.facebook.com)** → seu Business
2. **Configurações da Empresa** (engrenagem) → **Usuários** → **Usuários do Sistema**
3. Clica em **Adicionar** → nome: `inm-api`, função: **Admin**
4. Clica no usuário recém-criado → **Adicionar Ativos** → seleciona o app **Instituto Nova Medida** + a conta WhatsApp Business → Controle Total
5. Clica em **Gerar Novo Token** → seleciona o app + permissões:
   - `whatsapp_business_messaging` (enviar mensagens)
   - `whatsapp_business_management` (gerenciar templates)
   - `business_management`
6. Define expiração: **Nunca**
7. Copia o token (aparece só uma vez!) e me manda

> **Esse passo só precisa ser feito quando formos pra produção.** Por enquanto, o token de 24h é suficiente.

---

## Passo 4 · Verificar o número WhatsApp Business

Para enviar mensagens em produção, o número precisa estar:
- ✅ **Verificado** pela Meta
- ✅ **Display name aprovado**
- ✅ **Categoria correta** (Saúde / Health)

Faz isso em:
- WhatsApp → **Configurações** → **Detalhes do perfil** → preencher e submeter

> Aprovação leva de 1 a 5 dias úteis. Vamos começar isso em paralelo.

---

## Passo 5 · Templates de mensagem (faremos depois)

Para enviar mensagens fora da janela de 24h da iniciativa do cliente, precisamos de **templates aprovados pela Meta**.

Os templates do nosso fluxo (MSG 1–10 da estratégia) serão criados e submetidos no Sprint 2 fase 2:

- `boas_vindas_inicial` (MSG 1)
- `educacao_metodo` (MSG 2)
- `acessibilidade` (MSG 3 + 5)
- `dependencia_do_caso` (MSG 4)
- `proxima_etapa` (MSG 6)
- `como_funciona` (MSG 7)
- `gratuita_se_nao_indicado` (MSG 8)
- `encaminhamento` (MSG 9)
- `link_agendamento` (MSG 10)
- `followup_3dias`

Aprovação de cada template: 1-24h normalmente.

---

## Passo 6 · Webhook (faremos depois)

Configurar webhook em:
- WhatsApp → **Configuração** → **Webhooks** → **Editar**
- URL de callback: `https://institutonovamedida.com.br/api/wa/webhook` (em prod)
- Token de verificação: `inm_webhook_2026_5fK9xQp2vR7nL3mZ` (já está no `.env.local`)
- Inscrever em: `messages`, `message_template_status_update`

---

## Custos Cloud API

A Meta cobra por **conversação** (24h):

| Categoria | Preço Brasil (estimativa) |
|---|---|
| Marketing (iniciada por nós) | ~R$ 0,40 / conversa |
| Utility (transacional, pós-pedido) | ~R$ 0,15 / conversa |
| Authentication (OTP) | ~R$ 0,10 / conversa |
| Service (resposta ao cliente em 24h) | gratuito até 1000/mês |

> 1000 conversações de serviço grátis por mês cobre confortavelmente nossos primeiros pacientes.

---

## O que me mandar agora (e pendências imediatas)

✅ WABA ID (recebido)
✅ Phone Number ID (recebido)
✅ Access Token temporário (recebido, gravado em `.env.local`)
✅ Pipeline `/api/lead → Supabase → WhatsApp` plugado e validado

❌ **Você precisa verificar +55 21 99732-2906 no painel da Meta** (Passo 1.5)
   → após isso, qualquer lead criado pelo site dispara mensagem real
   no seu WhatsApp, sem mexer em nada de código.

❌ Submeter template `boas_vindas_inicial` no WhatsApp Manager (a copy
   está em `docs/COPY.md`). Aprovação leva ~1-24h. Hoje estamos usando
   `hello_world` (template default da Meta) só pra exercitar o pipeline.

❌ (Em paralelo, opcional) Abrir caso no Meta Business Support pra
   destravar o número próprio +55 21 99732-2906 como REMETENTE (erro
   #2655121) — não é bloqueio, podemos viver indefinidamente no test
   number durante o desenvolvimento.
