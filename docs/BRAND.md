# Identidade · Instituto Nova Medida

## Nome

**Instituto Nova Medida.**

Carrega duplo sentido proposital: "Nova Medida" como medida do corpo
(emagrecimento) e "nova medida" como nova abordagem/método. "Instituto"
ancora autoridade científica e seriedade médica.

## Tagline

> **Não é sobre força de vontade — é sobre o método certo.**

Variações curtas para ads:
- "Uma nova medida para o seu corpo."
- "Avaliação médica online, individual e sem compromisso."

## Voz da marca

- **Acolhedora, nunca paternalista.** Trata o paciente como adulto.
- **Honesta, nunca sensacionalista.** Não promete milagre.
- **Técnica quando necessário, simples sempre que possível.**
- **Brasileira contemporânea.** Sem palavras importadas desnecessárias.

### Faz
- "Avaliação individual"
- "Quando faz sentido para você"
- "Método baseado em ciência"
- "Sua médica acompanha cada etapa"

### Não faz
- "Emagreça X kg em Y dias"
- "Resultado garantido"
- "Antes/depois"
- "Tratamento revolucionário/milagroso"

## Paleta

| Token | HEX | Uso |
|---|---|---|
| `cream-50` | `#FDFBF7` | Backgrounds claros, modais |
| `cream-100` | `#FAF7F2` | **Background principal** |
| `cream-200` | `#F4EFE6` | Seções alternadas |
| `cream-300` | `#E8DFD3` | Bordas suaves |
| `sage-500` | `#5C7A6A` | **Verde-sálvia (cor primária acento)** |
| `sage-600` | `#4A6354` | Hover, ações |
| `sage-700` | `#3B4F44` | Backgrounds escuros temáticos |
| `terracotta-500` | `#C97B5E` | **Acento quente (CTA secundário, destaques)** |
| `terracotta-700` | `#8C4F3B` | Texto sobre claro (raros casos) |
| `ink-500` | `#4A463E` | Texto secundário |
| `ink-700` | `#2A2620` | Subtítulos |
| `ink-800` | `#1C1A16` | **Texto principal** |
| `ink-900` | `#0F0E0B` | Backgrounds escuros (Shift, Footer) |

A paleta é deliberadamente **terrosa, calma, premium**. Inspiração:
estética editorial (NYT Magazine, Kinfolk), saúde acolhedora (Oviva),
minimalismo sofisticado (claude.com).

## Tipografia

| Família | Uso | Pesos |
|---|---|---|
| **Fraunces** (display serif) | Títulos, números grandes, citações | 400, 500 (variável opsz + SOFT) |
| **Inter** (sans-serif) | Corpo, UI, legendas | 400, 500, 600 |

- Tracking ligeiramente apertado em headlines (`-0.025em`)
- Recurso `text-balance` em headlines para evitar viúvas
- Itálico do Fraunces usado para destacar palavras-chave (não para frases
  inteiras)

## Logo

Composição: monograma circular com formas que evocam:
- **N** estilizado (Nova) → linha angular interna
- **Pingo terracotta** → ponto de inflexão / mudança
- **Círculo sage** → continuidade, ciclo de cuidado

Bilinha "Instituto / Nova Medida" em Fraunces ao lado do mark.

Versões:
- **Horizontal** (padrão, header e rodapé)
- **Mark-only** (favicon, app icon)
- Cor sobre cream e cor sobre dark (footer)

## Iconografia

- **SVG inline custom**, traços de 1.4–1.7px
- Sem ícones de bibliotecas como Material/FontAwesome (estilizados demais)
- Cantos arredondados sutis (`stroke-linecap="round"`)

## Microcopy padrão

| Botão | Texto |
|---|---|
| CTA primário | "Começar agora" / "Veja o que faz sentido no seu caso" |
| CTA secundário | "Receber meu retorno pelo WhatsApp" |
| Loading | "Registrando…" |
| Sucesso | "Recebemos sua avaliação, [nome]." |
| Compartilhar | "Enviar pelo WhatsApp" / "Copiar link" |

## Imagens

- **Pessoas reais.** Diversidade de idade, etnia, biotipo. Não estamos
  vendendo "corpo perfeito".
- **Iluminação natural.** Tons quentes que casem com a paleta.
- **Sem cara de banco de imagem.** Momentos genuínos.
- Ambiente: cotidiano brasileiro contemporâneo, não estúdio asséptico.

## Movimento

- Suave, com easing `[0.22, 1, 0.36, 1]` (cubic-bezier "out-quart")
- Durações: 300–700ms para reveals; 200–300ms para microinterações
- Nada salta. Nada chama atenção desnecessária.
