# Documentação · Instituto Nova Medida

Esta pasta concentra **toda a documentação viva** do projeto. Cada arquivo
tem um propósito claro e é atualizado a cada sessão de desenvolvimento.

## Índice

| Documento | O que tem dentro |
|---|---|
| [`PRODUCT.md`](./PRODUCT.md) | Visão de produto, modelo de negócio, personas, jornada |
| [`DECISIONS.md`](./DECISIONS.md) | Registro de decisões (ADR-style): o que escolhemos, por quê, alternativas |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Arquitetura técnica, stack, integrações, diagramas |
| [`SPRINTS.md`](./SPRINTS.md) | Cronograma de sprints, escopo de cada um, status |
| [`COMPLIANCE.md`](./COMPLIANCE.md) | Checklist regulatório (CFM, Anvisa, LGPD) — vivo |
| [`PRICING.md`](./PRICING.md) | Tiers de plano, preços, splits, lógica financeira |
| [`BRAND.md`](./BRAND.md) | Identidade visual, paleta, tipografia, voz da marca |
| [`COPY.md`](./COPY.md) | Copy oficial da landing e do fluxo WhatsApp |
| [`CHANGELOG.md`](./CHANGELOG.md) | Registro cronológico de tudo que foi entregue |
| [`SECRETS.md`](./SECRETS.md) | Lista de credenciais necessárias (Supabase, Asaas, Memed, Daily, Meta) — só nomes, sem valores |
| [`META_SETUP.md`](./META_SETUP.md) | Passo-a-passo para configurar a Meta (WhatsApp Cloud API + Marketing API) |

## Convenções

- Toda decisão importante vira uma entrada em `DECISIONS.md` no formato:
  `## D-XXX · Título · Data` → Contexto · Decisão · Alternativas · Consequências
- Toda sessão de desenvolvimento gera uma entrada em `CHANGELOG.md` com data,
  o que foi feito e onde.
- Toda pendência vira issue no `SPRINTS.md`, marcada com `[ ]` ou `[x]`.
- Documentos são em **português brasileiro**, claros, sem jargão desnecessário.
