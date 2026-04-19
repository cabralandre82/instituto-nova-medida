# Compliance · Instituto Nova Medida

> Documento vivo. Revisar a cada mudança regulatória relevante.
> Última revisão: **2026-04-19**.

## Marcos regulatórios aplicáveis

| Norma | Tema | O que exige de nós |
|---|---|---|
| **Lei nº 14.510/2022** | Telemedicina (lei) | Reconhece telemedicina como prática médica permanente |
| **Resolução CFM nº 2.314/2022** | Telemedicina (regulamentação) | Plataforma compliant, TCLE, prontuário, ICP-Brasil |
| **Resolução CFM nº 1.974/2011 + atualizações** | Publicidade médica | Sem promessa de resultado, sem antes/depois, identificação de RT |
| **Lei nº 13.709/2018 (LGPD)** | Proteção de dados | Consentimento, finalidade, DPO, direitos do titular |
| **Lei nº 6.360/1976 + RDC 96/2008** | Publicidade de medicamentos | Não pode anunciar medicamento controlado diretamente |
| **RDC nº 67/2007** | Boas práticas de manipulação | Aplicável às farmácias parceiras |
| **Nota Técnica Anvisa nº 200/2025** | IFAs agonistas de GLP-1 | Tirzepatida manipulada permitida com requisitos rígidos |
| **RDC nº 471/2021** | Receituários (controlados) | Conservação de prescrições |

## Checklist atual da landing

### Publicidade médica (CFM)
- [x] Não promete resultado
- [x] Não usa "antes/depois"
- [x] Não cita nome de medicamento controlado
- [x] Linguagem cuidadosa: "tecnologias modernas", "atuam no apetite e
      metabolismo"
- [x] Espaço para identificação do RT (CRM/UF) no footer
- [ ] **CRM da RT a preencher quando contratada**

### LGPD
- [x] Opt-in explícito no formulário de captura
- [x] Link para Política de Privacidade (placeholder)
- [x] Footer com referência ao DPO (`dpo@institutonovamedida.com.br`)
- [x] Coleta mínima (só nome + WhatsApp + respostas do quiz)
- [x] IP e User-Agent registrados como evidência de consentimento
- [ ] **Política de Privacidade redigida por advogado de saúde**
- [ ] **Termos de Uso redigidos por advogado de saúde**
- [ ] **DPO formalmente nomeado**
- [ ] **Painel de exercício de direitos do titular**

### CFM 2.314/2022 — Telemedicina (próximos sprints)
- [ ] TCLE eletrônico específico para teleconsulta
- [ ] Sala de vídeo com criptografia E2E (Daily.co com regional residency BR)
- [ ] Identificação visível do médico (nome + CRM/UF) durante toda a sessão
- [ ] Prontuário completo com data, hora, queixa, exame, conduta
- [ ] Plataforma com sede no Brasil (ou processamento conforme LGPD)
- [ ] Receita controlada com assinatura ICP-Brasil (via Memed)
- [ ] Hospedagem com região São Paulo (Supabase BR)

### Anvisa — Tirzepatida manipulada (operação)
- [ ] Onboarding de farmácia parceira com upload de:
  - [ ] Licença sanitária vigente
  - [ ] Certificado de IFA da distribuidora autorizada
  - [ ] Laudos de qualidade por lote (HPLC/UV, pureza ≥98%, esterilidade,
        endotoxinas)
- [ ] Prescrição individualizada com justificativa clínica documentada
- [ ] Rastreabilidade lote → paciente (registrado no prontuário)

## Riscos regulatórios monitorados

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Anvisa restringir mais a manipulação de tirzepatida | Média | Alto | Plataforma já preparada para semaglutida e retatrutida (futuro); modelo não depende exclusivamente da tirzepatida |
| CFM endurecer regras de telemedicina | Baixa | Médio | Já estamos no padrão mais alto (NGS2, ICP-Brasil) |
| Mudança nas regras de publicidade médica | Baixa | Médio | Copy já é cuidadosa; revisão jurídica trimestral |
| Vazamento de dados sensíveis | Baixa | Crítico | RLS, criptografia, mínima coleta, auditoria de logs |

## Cadência de revisão

- **Mensal:** scan de mudanças regulatórias (CFM, Anvisa, ANPD)
- **Trimestral:** revisão jurídica completa por advogado de saúde
- **Anual:** auditoria externa de LGPD
