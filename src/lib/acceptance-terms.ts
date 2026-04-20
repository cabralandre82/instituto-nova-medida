/**
 * Termo de consentimento e contratação do plano terapêutico (D-044 · 2.C).
 *
 * Este arquivo é tratado como **artefato jurídico versionado**:
 *
 *   - A versão ativa exibida ao paciente no `/paciente/oferta` é
 *     sempre a mais recente publicada.
 *   - Versões antigas permanecem neste arquivo indefinidamente,
 *     porque cada row em `plan_acceptances` guarda a string exata
 *     aceita — mas se alguém precisar auditar o texto-tipo vigente
 *     em uma data passada, é este histórico que prova.
 *   - Mudança de termo ⇒ nova versão ⇒ nova constante. Nunca se
 *     edita uma versão já publicada (teste unitário bloqueia).
 *
 * Estrutura do texto:
 *   - Preâmbulo, 9 cláusulas e assinatura simbólica.
 *   - Placeholders no formato `{chave}` que o render substitui em
 *     runtime com dados da paciente, da médica e do plano.
 *
 * Fundamentos normativos citados ou implícitos:
 *   - Resolução CFM nº 2.314/2022 (telemedicina);
 *   - Lei nº 13.709/2018 – LGPD, art. 11, II, "a" (consentimento
 *     específico para dado pessoal sensível de saúde);
 *   - Lei nº 8.078/1990 – CDC, art. 49 (direito de arrependimento)
 *     e seu § único, com a exceção do produto personalizado;
 *   - Lei nº 5.991/1973 (dispensação) e Lei nº 13.021/2014
 *     (assistência farmacêutica em farmácia magistral);
 *   - Código de Ética Médica (Resolução CFM nº 2.217/2018).
 *
 * NB: este texto é denso por natureza (é contrato). Foi redigido
 * em registro jurídico formal com precisão normativa, mas evitando
 * latinismos e jargão obscuro — o paciente médio precisa conseguir
 * ler até o fim.
 */

export const ACCEPTANCE_TERMS_VERSION = "v1-2026-04" as const;
export type AcceptanceTermsVersion = typeof ACCEPTANCE_TERMS_VERSION;

/**
 * Parâmetros injetados no template no momento de renderização.
 *
 * `price_formatted` vem pronto do chamador (R$ 1.797,00) porque a
 * formatação depende da forma de pagamento (PIX vs. cartão) — que
 * é responsabilidade da camada de aceite, não deste módulo.
 */
export type AcceptanceTermsParams = {
  patient_name: string;
  patient_cpf: string;
  plan_name: string;
  plan_medication: string;
  plan_cycle_days: number;
  price_formatted: string;
  doctor_name: string;
  doctor_crm: string;       // ex: "123456/SP"
  prescription_url: string;
};

// ────────────────────────────────────────────────────────────────────────
// Template v1 — abril/2026
// ────────────────────────────────────────────────────────────────────────

const V1_TEMPLATE = `TERMO DE CONSENTIMENTO E CONTRATAÇÃO DE PLANO TERAPÊUTICO
Instituto Nova Medida — Versão v1 · abril/2026

Por este instrumento, {patient_name}, inscrito(a) no CPF {patient_cpf}, adiante denominado(a) PACIENTE, manifesta de forma livre, informada e inequívoca sua concordância com os termos abaixo, para contratar o plano terapêutico {plan_name} junto ao Instituto Nova Medida, adiante denominado INSTITUTO.

1. Objeto
O presente termo tem por objeto a contratação do plano {plan_name}, compreendendo a aquisição, por conta do INSTITUTO, de medicamento manipulado ({plan_medication}) suficiente para um ciclo terapêutico de {plan_cycle_days} dias, e a respectiva entrega no endereço indicado pelo(a) PACIENTE no momento deste aceite, pelo valor total de {price_formatted}, em pagamento único à vista.

2. Prescrição Médica
A contratação se fundamenta em prescrição médica emitida em ato clínico de telemedicina por {doctor_name}, CRM {doctor_crm}, nos termos da Resolução CFM nº 2.314/2022, disponível em {prescription_url}. A prescrição é ato médico pessoal e intransferível, restrita exclusivamente ao(à) PACIENTE identificado(a) neste termo, vedada sua cessão, compartilhamento ou utilização por terceiros.

3. Veracidade das Informações Clínicas
O(A) PACIENTE declara que as informações clínicas, antecedentes pessoais e familiares, medicamentos em uso e demais dados de saúde fornecidos durante a teleconsulta correspondem à realidade. Está ciente de que omissões ou inveracidades podem comprometer a adequação da conduta prescrita e afastam, na proporção de sua causa, a responsabilidade do INSTITUTO e da equipe médica por desfechos adversos delas decorrentes.

4. Consentimento para Tratamento de Dados Pessoais Sensíveis de Saúde
Nos termos do art. 11, inciso II, alínea "a", da Lei nº 13.709/2018 (LGPD), o(a) PACIENTE consente, de forma específica e destacada, com o tratamento de seus dados pessoais sensíveis de saúde pelo INSTITUTO para as finalidades desta contratação, bem como com seu compartilhamento estritamente necessário com (i) a farmácia de manipulação parceira, limitado aos dados indispensáveis ao aviamento da prescrição (notadamente nome, CPF e a própria prescrição), e (ii) prestadores de serviço logístico, limitado aos dados necessários à entrega do medicamento. O endereço de entrega do(a) PACIENTE não é compartilhado com a farmácia de manipulação. Os tratamentos aqui autorizados vigoram enquanto necessários ao cumprimento deste contrato e às obrigações legais, regulatórias e contábeis decorrentes.

5. Fluxo Operacional e Pagamento
A confirmação do pagamento do valor integral, pelos meios disponibilizados na plataforma de pagamento contratada pelo INSTITUTO, é condição para o início do aviamento. Confirmado o pagamento, o INSTITUTO encaminhará a prescrição à farmácia de manipulação parceira, receberá o medicamento pronto e providenciará o despacho ao endereço informado neste termo. O despacho ao(à) PACIENTE é operação de responsabilidade exclusiva do INSTITUTO.

6. Cancelamento, Arrependimento e Reembolso
6.1. Antes da confirmação do pagamento, o(a) PACIENTE poderá desistir da contratação sem qualquer ônus.
6.2. Após a confirmação do pagamento e antes do encaminhamento da prescrição à farmácia de manipulação, a contratação poderá ser cancelada mediante solicitação expressa, com reembolso integral do valor pago, a ser processado pelos meios da plataforma de pagamento no prazo por ela praticado.
6.3. Uma vez encaminhada a prescrição à farmácia de manipulação, não caberá desistência nem reembolso, por tratar-se de medicamento manipulado produzido sob medida, conforme especificações individuais do(a) PACIENTE, enquadrando-se como produto personalizado fora do alcance do direito de arrependimento do art. 49 do Código de Defesa do Consumidor (Lei nº 8.078/1990), em consonância com a disciplina da dispensação prevista na Lei nº 5.991/1973, na Lei nº 13.021/2014 e na regulamentação sanitária aplicável às farmácias magistrais.

7. Riscos Inerentes ao Tratamento
O(A) PACIENTE declara estar ciente de que todo tratamento farmacológico comporta riscos, incluindo efeitos adversos previstos em bula e na literatura médica, e assume os seguintes compromissos: (a) seguir rigorosamente a posologia, a via de administração e o período prescritos; (b) comunicar prontamente, pelos canais do INSTITUTO, qualquer reação adversa ou intercorrência; (c) buscar avaliação médica presencial e, se for o caso, atendimento de urgência, diante de sintomas que configurem emergência. O INSTITUTO não se responsabiliza por desdobramentos decorrentes do uso em desconformidade com a prescrição, de dados clínicos omitidos ou inverídicos, ou de ato de terceiro.

8. Comunicações
O(A) PACIENTE autoriza o envio de comunicações relativas a este contrato (confirmações de pagamento, aviamento, despacho, entrega e eventuais atualizações clínicas do tratamento) pelos canais por si informados, notadamente WhatsApp e correio eletrônico, observadas as disposições da Lei nº 13.709/2018.

9. Foro
Fica eleito o foro da comarca do domicílio do(a) PACIENTE para dirimir eventuais controvérsias decorrentes deste termo, sem prejuízo da utilização prévia dos canais de atendimento do INSTITUTO para tentativa de solução amigável.

Ao registrar a concordância por meio eletrônico neste termo, o(a) PACIENTE declara ter lido integralmente seu conteúdo, compreendido seus efeitos jurídicos e manifestado, por ato inequívoco, sua concordância com todas as disposições acima.`;

// ────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────

/**
 * Renderiza o termo com os dados reais da contratação.
 *
 * Valida que **todos** os placeholders foram substituídos —
 * qualquer `{chave}` remanescente é bug de chamador, e o render
 * explode em tempo de desenvolvimento pra evitar que um aceite
 * seja registrado com placeholders não-resolvidos (hash inútil e
 * prova legal viciada).
 */
export function renderAcceptanceTerms(params: AcceptanceTermsParams): string {
  const text = V1_TEMPLATE.replace(
    /\{(\w+)\}/g,
    (match, key: keyof AcceptanceTermsParams) => {
      const value = params[key];
      if (value === undefined || value === null) {
        throw new Error(
          `renderAcceptanceTerms: placeholder "${match}" sem valor correspondente em params.`
        );
      }
      return String(value);
    }
  );

  // Verificação defensiva redundante — se sobrar "{chave}" no
  // texto final, é bug do template (placeholder que o params não
  // declara). Melhor crash em build/teste do que aceite viciado.
  if (/\{\w+\}/.test(text)) {
    throw new Error(
      "renderAcceptanceTerms: placeholders não substituídos remanescem no texto."
    );
  }

  return text;
}

/**
 * Formata CRM no padrão "NNNNNN/UF" pra uso no texto jurídico.
 * Zero dependência externa: se `crm_number` já vier com barra, só
 * passa através; caso contrário concatena com `crm_uf`.
 */
export function formatDoctorCrm(crmNumber: string, crmUf: string): string {
  if (crmNumber.includes("/")) return crmNumber.trim();
  return `${crmNumber.trim()}/${crmUf.trim().toUpperCase()}`;
}
