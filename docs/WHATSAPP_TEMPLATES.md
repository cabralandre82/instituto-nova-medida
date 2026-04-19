# Templates WhatsApp · Instituto Nova Medida

> 7 templates pra submeter na Meta WhatsApp Business Manager.
> Templates são obrigatórios pra mensagens **proativas** fora da
> janela de 24h após a última interação do paciente.
>
> Categoria escolhida: **UTILITY** (transação/serviço operacional)
> em vez de MARKETING — aprovação mais rápida e fee menor (US$ 0,005
> vs US$ 0,025 por mensagem).

---

## Submissão (passo a passo)

1. Acessar `business.facebook.com` → WhatsApp Manager
2. Selecionar a WABA `Instituto Nova Medida` (ID `3610674345738807`)
3. Templates → Criar template → escolher **Utility** + idioma `pt_BR`
4. Colar nome, header (se houver), body, variáveis (`{{1}}`, `{{2}}`...)
5. Submeter — aprovação típica: 1h-24h
6. Copiar nome do template aprovado pra `src/lib/whatsapp.ts`

---

## 1. `confirmacao_agendamento` — pós-agendamento

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 4

### Body

```
Olá, {{1}}! Sua consulta no Instituto Nova Medida está confirmada.

📅 *{{2}}*
👩‍⚕️ {{3}}

Você receberá um lembrete 1 hora antes e o link da sala 15 minutos antes do horário marcado.

Para reagendar ou cancelar, acesse: {{4}}
```

### Exemplo

```
Olá, Maria! Sua consulta no Instituto Nova Medida está confirmada.

📅 *Quinta-feira, 22 de Maio às 14h00*
👩‍⚕️ Dra. Joana Silva (CRM-RJ 12345)

Você receberá um lembrete 1 hora antes e o link da sala 15 minutos antes do horário marcado.

Para reagendar ou cancelar, acesse: https://institutonovamedida.com.br/c/abc123
```

### Disparado por

- API `POST /api/appointments` (sucesso) → `sendConfirmacaoAgendamento()`

---

## 2. `lembrete_consulta_24h` — 24h antes

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 3

### Body

```
Oi, {{1}}! Lembrando da sua consulta amanhã 👋

📅 *{{2}}* com {{3}}

Tudo certo? Se precisar reagendar, é só responder essa mensagem agora — depois fica difícil. 🙏
```

### Exemplo

```
Oi, Maria! Lembrando da sua consulta amanhã 👋

📅 *Quinta-feira às 14h00* com Dra. Joana Silva

Tudo certo? Se precisar reagendar, é só responder essa mensagem agora — depois fica difícil. 🙏
```

### Disparado por

- pg_cron (`appointments` com `scheduled_at` entre `now()+23h` e
  `now()+25h` e sem notification do tipo `T-24h` enviada)

---

## 3. `lembrete_consulta_1h` — 1h antes

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 2

### Body

```
{{1}}, sua consulta é em 1 hora ⏰

📅 {{2}}

Em 45 minutos enviamos o link da sala. Esteja em ambiente reservado, com boa iluminação e câmera funcionando. Pode testar agora se quiser.
```

### Exemplo

```
Maria, sua consulta é em 1 hora ⏰

📅 hoje às 14h00

Em 45 minutos enviamos o link da sala. Esteja em ambiente reservado, com boa iluminação e câmera funcionando. Pode testar agora se quiser.
```

### Disparado por

- pg_cron (appointments entre `now()+50min` e `now()+70min`)

---

## 4. `link_sala_consulta` — 15min antes

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 3

### Body

```
{{1}}, sua sala está pronta 🎥

🔗 *Entrar na consulta agora:*
{{2}}

Aberta a partir de agora até {{3}}.

⚠️ Use o navegador *Chrome*, *Edge* ou *Safari* (Firefox dá problema). Permita acesso à câmera e ao microfone quando o navegador pedir.
```

### Exemplo

```
Maria, sua sala está pronta 🎥

🔗 *Entrar na consulta agora:*
https://instituto-nova-medida.daily.co/c-abc-123

Aberta a partir de agora até 15h00.

⚠️ Use o navegador *Chrome*, *Edge* ou *Safari* (Firefox dá problema). Permita acesso à câmera e ao microfone quando o navegador pedir.
```

### Disparado por

- pg_cron (appointments entre `now()+10min` e `now()+20min`)

---

## 5. `vez_chegou_on_demand` — fila on-demand (NOVO)

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 3

### Body

```
{{1}}, é a sua vez! 🎉

A {{2}} acabou de te chamar para a consulta.

🔗 *Entrar agora (link válido por 5 minutos):*
{{3}}

Se você não entrar em 5 minutos, voltamos pra fila e chamamos a próxima pessoa. Mas garantimos sua prioridade nas próximas 4 horas.
```

### Exemplo

```
Maria, é a sua vez! 🎉

A Dra. Joana Silva acabou de te chamar para a consulta.

🔗 *Entrar agora (link válido por 5 minutos):*
https://instituto-nova-medida.daily.co/od-xyz789

Se você não entrar em 5 minutos, voltamos pra fila e chamamos a próxima pessoa. Mas garantimos sua prioridade nas próximas 4 horas.
```

### Disparado por

- API interna do `consultation_queue` quando médica clica "chamar
  próximo"

---

## 6. `pos_consulta_resumo` — pós-consulta com receita

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 3

### Body

```
{{1}}, obrigado pelo seu tempo na consulta de hoje 💚

📋 *Sua receita digital* (assinada com ICP-Brasil):
{{2}}

Resumo da conduta:
{{3}}

Qualquer dúvida sobre dose, efeitos ou logística da entrega, é só responder essa mensagem.
```

### Exemplo

```
Maria, obrigado pelo seu tempo na consulta de hoje 💚

📋 *Sua receita digital* (assinada com ICP-Brasil):
https://memed.com.br/r/abc-123-xyz

Resumo da conduta:
Iniciar Tirzepatida 2,5mg semanal, 1ª dose hoje à noite após o jantar. Reconsulta em 30 dias.

Qualquer dúvida sobre dose, efeitos ou logística da entrega, é só responder essa mensagem.
```

### Disparado por

- API `POST /api/appointments/[id]/finish` quando médica encerra
  consulta com prescrição vinculada

---

## 7. `pagamento_pix_pendente` — PIX expirando

**Categoria:** Utility
**Idioma:** pt_BR
**Variáveis:** 3

### Body

```
{{1}}, seu PIX do plano {{2}} expira em 12 horas ⏳

Para garantir o início do seu tratamento, finalize agora:
{{3}}

Pagamentos confirmados antes das 22h ainda permitem agendar consulta para amanhã.
```

### Exemplo

```
Maria, seu PIX do plano Avançado expira em 12 horas ⏳

Para garantir o início do seu tratamento, finalize agora:
https://www.asaas.com/i/abc123xyz

Pagamentos confirmados antes das 22h ainda permitem agendar consulta para amanhã.
```

### Disparado por

- pg_cron (payments com `billing_type='PIX'`, `status='PENDING'`,
  `due_date = today + 1` e sem notification recente)

---

## Templates internos (sem necessidade de aprovação Meta)

> Esses só são disparados em janela aberta de 24h após a paciente
> falar com a gente — texto livre, não precisa template.

### Auto-reply paciente

```
Recebi sua mensagem, {{nome}}! 👋
Vou te responder em até 1 hora útil. Se for urgência médica,
disque 192 (SAMU) ou vá ao pronto-socorro.
```

### Mensagem operacional pra médica (notificações fila/pagamento)

Texto livre — médicas estão sempre em janela aberta porque interagem
toda hora com o sistema.

---

## Templates pra equipe interna

### `medica_repasse_pago` (UTILITY, pt_BR, 4 vars)

```
Dra. {{1}}, seu repasse de {{2}} foi pago via PIX 💸

💰 *Valor: R$ {{3}}*

Comprovante em anexo no painel: {{4}}

Por favor, emita a NF-e correspondente em até 10 dias e anexe no painel.
```

### `medica_documento_pendente` (UTILITY, pt_BR, 3 vars)

```
Dra. {{1}}, lembrando que precisamos da NF-e do repasse de {{2}} 📄

💰 Valor: R$ {{3}}

Faltando há mais de 10 dias. Pode enviar pelo painel:
https://institutonovamedida.com.br/medico/financeiro
```

---

## Anexo: nomenclatura

- Prefixo `inm_` ou nome direto: a Meta não exige prefixo, mas
  ajuda a identificar nossos templates entre os do número compartilhado.
- Sugestão final: usar nome direto sem prefixo (mais limpo).

## Anexo: idiomas

Todos em `pt_BR`. Não criar versão em inglês ou espanhol no MVP.

## Anexo: rotação de templates

Se uma versão for rejeitada, criar v2 (`confirmacao_agendamento_v2`)
em vez de editar a aprovada. Switching feito por env var
`WHATSAPP_TEMPLATE_VERSION` na lib (default `1`).

## Anexo: rate limit

Tier inicial Meta = 1.000 mensagens/24h por destinatário, **mas**
limite por número de telefone do remetente: 1.000 conversações
únicas/dia em Tier 1. Subir pra Tier 2 (10k) requer 24h sem bloqueio
+ qualidade da conta verde.

Pra MVP é suficiente. Quando passarmos de 800 conversações únicas/dia
acionar Meta pra subir Tier.
