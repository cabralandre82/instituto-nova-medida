# Pricing · Instituto Nova Medida

## Premissa

- Custo da tirzepatida manipulada (referência do operador): **R$ 1.200 por
  60mg**.
- Doses semanais variam de 2,5mg (início) até 15mg (manutenção).
- Ciclo padrão: **90 dias** (≈ 12 semanas, alinhado ao ciclo clínico).

## Custo do medicamento por ciclo de 90 dias

| Dose semanal | mg em 90 dias | Custo (R$) |
|---|---|---|
| 2,5mg | 30mg | 600 |
| 5mg | 60mg | 1.200 |
| 7,5mg | 90mg | 1.800 |
| 10mg | 120mg | 2.400 |
| 12,5mg | 150mg | 3.000 |
| 15mg | 180mg | 3.600 |

## Tiers de plano (proposta inicial)

| Plano | Medicamento | Doses cobertas | Preço/ciclo (3x sem juros) | Preço à vista (PIX/boleto) | Margem bruta estimada* |
|---|---|---|---|---|---|
| **Essencial** | Semaglutida manipulada | até 1mg/sem | R$ 1.797 (3x R$ 599) | R$ 1.617 (-10%) | ~50% |
| **Avançado** | Tirzepatida 2,5–7,5mg | inclui escalonamento | R$ 2.997 (3x R$ 999) | R$ 2.697 (-10%) | ~45% |
| **Avançado Plus** | Tirzepatida 10–15mg | manutenção/dose alta | R$ 4.197 (3x R$ 1.399) | R$ 3.777 (-10%) | ~40% |
| **Premium** *(reservado)* | Retatrutida | aguardando aprovação Anvisa | a definir | a definir | — |

> *Margem bruta = preço − (custo med + custo médico + taxa Asaas + custos
> operacionais). Detalhamento abaixo.

## Composição de custo por ciclo (Plano Avançado, exemplo)

| Item | Valor (R$) |
|---|---|
| Custo do medicamento (médio das doses 2,5–7,5mg) | ~900 |
| Repasse à médica (consulta inicial + 2 reconsultas em 90 dias) | 400 |
| Taxa Asaas (cartão 3x ≈ 4,5%) | ~135 |
| Operacional (WhatsApp, Daily, infra) | ~50 |
| **Total de custos** | **~1.485** |
| **Preço de venda** | **2.997** |
| **Margem bruta** | **~50,5%** |

## Pagamento

- **PIX à vista** com 10% de desconto sobre o preço-cheio
- **Boleto à vista** com 10% de desconto
- **Cartão de crédito** em até **3x sem juros** (Asaas absorve a taxa
  contra a margem)
- **Sem opção de parcelamento em PIX/boleto** (decisão do operador)

## Renovação

- Reconsulta gratuita ao final do ciclo (incluída)
- Renovação automática se paciente confirmar até 7 dias antes do fim →
  desconto de fidelidade de 10% no próximo ciclo (acumulável com PIX)
- Trocas de plano (subir de Avançado para Avançado Plus) prorratadas

## Split com a médica

- **Configurável no admin.** Sugestão inicial:
  - R$ 200 por consulta inicial
  - R$ 100 por reconsulta de 30 dias
- Repasse via **subaccount Asaas** (split automático no momento da
  cobrança)
- Médica recebe via PIX no D+1 (configuração padrão Asaas)

## Política de "consulta gratuita"

Se a médica avaliar e **não houver indicação clínica**, o paciente
**não é cobrado**. Nesses casos:

- Plataforma absorve o custo do médico via fundo operacional (provisão de
  ~5% sobre receita bruta dos planos vendidos)
- Limite anti-abuso: **1 avaliação grátis por CPF a cada 12 meses**
  (a definir e configurar — não bloquear o paciente, apenas cobrar a
  consulta da segunda em diante)

## Compra do medicamento

A compra do medicamento é feita em **plataforma separada da farmácia
parceira**. O Instituto Nova Medida:
- **NÃO fatura** o medicamento
- **Apenas envia** os dados de prescrição e endereço de entrega para a
  farmácia (com consentimento explícito do paciente)
- A farmácia cobra direto do paciente

> Esta separação está alinhada com a Nota Técnica Anvisa nº 200/2025 e
> reduz risco regulatório.
