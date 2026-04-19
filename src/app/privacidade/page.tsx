import type { Metadata } from "next";
import {
  LegalShell,
  Section,
  P,
  UL,
  LI,
  H3,
  Aside,
  TOC,
} from "@/components/LegalShell";

export const metadata: Metadata = {
  title: "Política de Privacidade — Instituto Nova Medida",
  description:
    "Como o Instituto Nova Medida coleta, usa, armazena e protege seus dados pessoais e de saúde, em conformidade com a LGPD (Lei nº 13.709/2018).",
  alternates: { canonical: "/privacidade" },
  robots: { index: true, follow: true },
};

const SECTIONS = [
  { id: "quem-somos", label: "Quem somos e o controlador" },
  { id: "dados-coletados", label: "Dados que coletamos" },
  { id: "finalidades", label: "Para que usamos seus dados" },
  { id: "bases-legais", label: "Bases legais (LGPD)" },
  { id: "compartilhamento", label: "Com quem compartilhamos" },
  { id: "armazenamento", label: "Onde e por quanto tempo armazenamos" },
  { id: "seguranca", label: "Como protegemos seus dados" },
  { id: "seus-direitos", label: "Seus direitos como titular" },
  { id: "cookies", label: "Cookies e tecnologias similares" },
  { id: "menores", label: "Crianças e adolescentes" },
  { id: "transferencia-internacional", label: "Transferência internacional" },
  { id: "alteracoes", label: "Alterações nesta política" },
  { id: "contato", label: "Encarregado de Dados (DPO) e contato" },
];

export default function PrivacidadePage() {
  return (
    <LegalShell
      title="Política de Privacidade"
      intro="Esta política explica, de forma clara, como o Instituto Nova Medida trata seus dados pessoais — incluindo dados de saúde, considerados sensíveis pela LGPD. Leia com calma. Se algo não estiver claro, fale com a gente."
      updatedAt="19 de abril de 2026"
    >
      <TOC items={SECTIONS} />

      <Section id="quem-somos" title="1. Quem somos e quem é o controlador">
        <P>
          O <strong>Instituto Nova Medida</strong> é uma plataforma brasileira
          de telessaúde que oferece avaliação médica online, prescrição
          individualizada quando indicada e acompanhamento contínuo para
          pessoas com sobrepeso ou obesidade.
        </P>
        <P>
          Para fins da Lei Geral de Proteção de Dados (LGPD — Lei nº
          13.709/2018), o <strong>controlador</strong> dos seus dados é o{" "}
          <strong>Instituto Nova Medida Saúde Ltda.</strong>, inscrito no CNPJ
          [a preencher], com sede em [endereço a preencher].
        </P>
        <P>
          As médicas e os médicos parceiros que realizam suas consultas são{" "}
          <strong>controladores independentes</strong> dos dados clínicos
          gerados durante o atendimento (prontuário, prescrição, conduta), nos
          termos do sigilo médico estabelecido pelo Código de Ética Médica.
        </P>
      </Section>

      <Section id="dados-coletados" title="2. Dados que coletamos">
        <P>
          Coletamos apenas o necessário para oferecer o serviço com segurança e
          qualidade. Categorizamos assim:
        </P>

        <H3>2.1. Dados que você nos fornece diretamente</H3>
        <UL>
          <LI>
            <strong>Identificação:</strong> nome completo, telefone celular,
            e-mail, CPF, data de nascimento, sexo biológico, endereço de
            entrega.
          </LI>
          <LI>
            <strong>Dados de saúde (sensíveis):</strong> peso, altura, medidas,
            histórico de comorbidades (diabetes, hipertensão, etc), histórico
            de tentativas anteriores de emagrecimento, exames laboratoriais,
            uso atual e prévio de medicamentos, alergias, gestação ou
            amamentação, hábitos alimentares e de sono.
          </LI>
          <LI>
            <strong>Dados clínicos gerados na consulta:</strong> anamnese,
            hipóteses diagnósticas, prescrições, pedidos de exame, evolução do
            tratamento.
          </LI>
          <LI>
            <strong>Dados de pagamento:</strong> tokenizados pelo provedor
            (Asaas). <strong>Nunca armazenamos número de cartão.</strong>
          </LI>
        </UL>

        <H3>2.2. Dados que coletamos automaticamente</H3>
        <UL>
          <LI>
            <strong>Dados de navegação:</strong> endereço IP, tipo de
            dispositivo, navegador, sistema operacional, páginas visitadas,
            tempo de permanência, origem do acesso (UTM e referrer).
          </LI>
          <LI>
            <strong>Cookies e identificadores:</strong> ver seção 9.
          </LI>
          <LI>
            <strong>Dados de comunicação:</strong> data, hora e status das
            mensagens trocadas pelo WhatsApp para fins de continuidade do
            atendimento. <strong>Não lemos rotineiramente</strong> o conteúdo
            das suas conversas com sua médica — apenas o necessário para
            qualidade e auditoria, como exige o CFM.
          </LI>
        </UL>

        <H3>2.3. Dados que recebemos de terceiros</H3>
        <UL>
          <LI>
            <strong>Plataforma de pagamento (Asaas):</strong> status de
            cobranças, eventuais inadimplências.
          </LI>
          <LI>
            <strong>Plataforma de prescrição (Memed):</strong> confirmação de
            emissão e dispensação da receita.
          </LI>
          <LI>
            <strong>Farmácia parceira:</strong> status do envio do medicamento
            manipulado.
          </LI>
        </UL>
      </Section>

      <Section
        id="finalidades"
        title="3. Para que usamos seus dados (finalidades)"
      >
        <UL>
          <LI>
            <strong>Prestar o serviço:</strong> agendar e realizar a consulta,
            emitir prescrição quando indicada, intermediar a entrega do
            medicamento, oferecer acompanhamento contínuo.
          </LI>
          <LI>
            <strong>Acompanhamento clínico:</strong> registrar a evolução do
            tratamento, ajustar conduta, contatar você por WhatsApp para
            checagens periódicas.
          </LI>
          <LI>
            <strong>Cumprir obrigações legais:</strong> guarda de prontuário
            (Resolução CFM nº 1.821/2007), emissão de notas fiscais, prevenção
            a fraudes.
          </LI>
          <LI>
            <strong>Segurança e auditoria:</strong> investigar incidentes,
            evitar uso indevido da plataforma.
          </LI>
          <LI>
            <strong>Comunicação:</strong> avisar sobre status de consulta,
            cobranças, alterações importantes no serviço, lembrar de exames e
            reconsultas.
          </LI>
          <LI>
            <strong>Marketing (apenas com seu consentimento):</strong> envio de
            conteúdos educativos sobre emagrecimento e novidades da
            plataforma. Você pode descadastrar a qualquer momento.
          </LI>
          <LI>
            <strong>Melhoria do produto:</strong> análises agregadas e
            anonimizadas para entender como nosso serviço pode ficar melhor.
          </LI>
        </UL>

        <Aside>
          <strong>Não vendemos seus dados.</strong> Nunca. Em nenhuma
          hipótese. Telessaúde só funciona com confiança — e confiança não tem
          preço.
        </Aside>
      </Section>

      <Section id="bases-legais" title="4. Bases legais (LGPD)">
        <P>
          A LGPD exige que toda coleta de dados pessoais tenha uma base legal
          que a autorize. As nossas são:
        </P>
        <UL>
          <LI>
            <strong>Execução de contrato</strong> (art. 7º, V) — para realizar
            a consulta, prescrever, intermediar entrega do medicamento e
            cobrar pelos serviços contratados.
          </LI>
          <LI>
            <strong>Consentimento</strong> (art. 7º, I e art. 11, I) — para
            tratamento de dados sensíveis de saúde, comunicações de marketing
            e cookies não essenciais.
          </LI>
          <LI>
            <strong>Tutela da saúde</strong> (art. 11, II, &quot;f&quot;) —
            para o exercício da medicina pela profissional de saúde
            responsável pelo seu atendimento.
          </LI>
          <LI>
            <strong>Cumprimento de obrigação legal</strong> (art. 7º, II) —
            para guarda de prontuário, contabilidade e atendimento a
            requisições de autoridades.
          </LI>
          <LI>
            <strong>Legítimo interesse</strong> (art. 7º, IX) — para segurança
            da plataforma, prevenção a fraudes e melhorias agregadas, sempre
            com proporcionalidade e respeito aos seus direitos.
          </LI>
        </UL>
      </Section>

      <Section
        id="compartilhamento"
        title="5. Com quem compartilhamos seus dados"
      >
        <P>
          Compartilhamos apenas o necessário, e apenas com quem precisa para
          que o serviço funcione:
        </P>
        <UL>
          <LI>
            <strong>Médicas e médicos parceiros</strong> — recebem seu
            histórico clínico para realizar a consulta. Estão sujeitos a
            sigilo médico.
          </LI>
          <LI>
            <strong>Farmácias de manipulação parceiras</strong> — recebem nome,
            endereço, telefone e a prescrição médica para preparar e enviar o
            medicamento.
          </LI>
          <LI>
            <strong>Asaas</strong> (processamento de pagamentos) — recebe
            dados estritamente financeiros para emissão de cobranças.
          </LI>
          <LI>
            <strong>Memed</strong> (prescrição digital) — recebe dados
            necessários para emissão da receita com assinatura ICP-Brasil.
          </LI>
          <LI>
            <strong>Provedor de videoconsulta</strong> — recebe seus dados de
            identificação para criar a sala segura. As gravações, se
            existirem, ficam sob nosso controle.
          </LI>
          <LI>
            <strong>Provedores de infraestrutura</strong> (Supabase para banco
            de dados, Vercel para hospedagem, Meta para WhatsApp Business
            API) — processam dados sob contrato de operador (art. 5º, VII da
            LGPD), com cláusulas de confidencialidade.
          </LI>
          <LI>
            <strong>Autoridades públicas</strong> — quando legalmente
            obrigados (decisão judicial, ofício de autoridade competente,
            requisição válida).
          </LI>
        </UL>
        <P>
          Todos os parceiros são previamente avaliados quanto à conformidade
          com a LGPD e estão vinculados por contrato a padrões mínimos de
          segurança.
        </P>
      </Section>

      <Section
        id="armazenamento"
        title="6. Onde e por quanto tempo armazenamos"
      >
        <P>
          Seus dados são armazenados em servidores localizados no{" "}
          <strong>Brasil</strong> (região São Paulo) sempre que possível.
          Provedores específicos podem manter cópias em outras jurisdições com
          garantias adequadas — ver seção 11.
        </P>
        <H3>Prazos de retenção</H3>
        <UL>
          <LI>
            <strong>Prontuário médico:</strong> mínimo de 20 anos a partir do
            último registro (Resolução CFM nº 1.821/2007). Após esse prazo,
            pode ser anonimizado para fins estatísticos.
          </LI>
          <LI>
            <strong>Dados financeiros e fiscais:</strong> 5 anos após o
            término do contrato (art. 174 do CTN; art. 11 da Lei nº
            8.218/1991).
          </LI>
          <LI>
            <strong>Dados de navegação e logs de acesso:</strong> 6 meses
            (art. 15 do Marco Civil da Internet).
          </LI>
          <LI>
            <strong>Comunicações de WhatsApp:</strong> 5 anos para fins de
            auditoria do atendimento.
          </LI>
          <LI>
            <strong>Dados de marketing:</strong> até você descadastrar.
          </LI>
        </UL>
      </Section>

      <Section id="seguranca" title="7. Como protegemos seus dados">
        <P>
          Adotamos medidas técnicas e administrativas compatíveis com o porte
          do tratamento e a sensibilidade dos dados envolvidos:
        </P>
        <UL>
          <LI>
            <strong>Criptografia em trânsito</strong> (HTTPS/TLS) em 100% das
            páginas e APIs.
          </LI>
          <LI>
            <strong>Criptografia em repouso</strong> no banco de dados.
          </LI>
          <LI>
            <strong>Controle de acesso baseado em função</strong> — cada
            colaborador acessa apenas o estritamente necessário (Row-Level
            Security no banco).
          </LI>
          <LI>
            <strong>Logs de auditoria</strong> de todos os acessos a dados
            sensíveis.
          </LI>
          <LI>
            <strong>Autenticação forte</strong> para profissionais e
            colaboradores.
          </LI>
          <LI>
            <strong>Backups</strong> diários com retenção de 30 dias e teste
            periódico de restauração.
          </LI>
          <LI>
            <strong>Plano de resposta a incidentes</strong> — comunicaremos a
            ANPD e você, sem demora indevida, em caso de incidente que possa
            acarretar risco ou dano relevante (art. 48 da LGPD).
          </LI>
        </UL>
      </Section>

      <Section id="seus-direitos" title="8. Seus direitos como titular">
        <P>
          A LGPD garante a você uma série de direitos sobre seus próprios
          dados. Você pode, a qualquer momento:
        </P>
        <UL>
          <LI>
            <strong>Confirmar</strong> a existência de tratamento dos seus
            dados.
          </LI>
          <LI>
            <strong>Acessar</strong> os dados que mantemos sobre você.
          </LI>
          <LI>
            <strong>Corrigir</strong> dados incompletos, inexatos ou
            desatualizados.
          </LI>
          <LI>
            <strong>Anonimizar, bloquear ou eliminar</strong> dados
            desnecessários, excessivos ou tratados em desconformidade com a
            LGPD.
          </LI>
          <LI>
            <strong>Solicitar a portabilidade</strong> dos seus dados a outro
            fornecedor.
          </LI>
          <LI>
            <strong>Eliminar</strong> dados tratados com base no seu
            consentimento — ressalvadas as hipóteses de retenção obrigatória
            (item 6).
          </LI>
          <LI>
            <strong>Saber com quem compartilhamos</strong> seus dados.
          </LI>
          <LI>
            <strong>Revogar o consentimento</strong> a qualquer momento.
          </LI>
          <LI>
            <strong>Opor-se</strong> a tratamento realizado com base em
            legítimo interesse.
          </LI>
          <LI>
            <strong>Peticionar diretamente à ANPD</strong> (Autoridade
            Nacional de Proteção de Dados) caso entenda que seus direitos
            foram violados.
          </LI>
        </UL>
        <P>
          Para exercer qualquer um desses direitos, escreva para nosso
          Encarregado de Dados (item 13). Respondemos em até 15 dias.
        </P>
      </Section>

      <Section id="cookies" title="9. Cookies e tecnologias similares">
        <P>
          Usamos cookies para fazer o site funcionar, lembrar suas preferências
          e medir o que precisa melhorar. São três categorias:
        </P>
        <UL>
          <LI>
            <strong>Essenciais:</strong> necessários para o site funcionar
            (sessão, segurança). Não exigem consentimento.
          </LI>
          <LI>
            <strong>Funcionais:</strong> lembram preferências (idioma, último
            passo do quiz).
          </LI>
          <LI>
            <strong>Analíticos:</strong> nos ajudam a entender como o site é
            usado, de forma agregada.
          </LI>
        </UL>
        <P>
          Você pode desabilitar cookies não essenciais nas configurações do
          seu navegador. Isso pode degradar a experiência mas não impede o
          uso do serviço.
        </P>
      </Section>

      <Section id="menores" title="10. Crianças e adolescentes">
        <P>
          O Instituto Nova Medida não atende menores de 18 anos. Não coletamos
          intencionalmente dados de crianças ou adolescentes. Se você é
          responsável legal e identificou um cadastro indevido, escreva ao DPO
          (item 13) para exclusão imediata.
        </P>
      </Section>

      <Section
        id="transferencia-internacional"
        title="11. Transferência internacional de dados"
      >
        <P>
          Alguns provedores que utilizamos possuem operações em outros países
          (por exemplo, Vercel/EUA para edge cache estático e Meta para
          WhatsApp Business API). Sempre que isso ocorre, garantimos que a
          transferência atende a uma das hipóteses do art. 33 da LGPD,
          tipicamente por meio de cláusulas contratuais específicas e
          provedores com programas de governança maduros.
        </P>
        <P>
          <strong>Dados clínicos sensíveis</strong> (prontuário, prescrições,
          videoconsulta) permanecem em servidores no Brasil sempre que
          possível.
        </P>
      </Section>

      <Section id="alteracoes" title="12. Alterações nesta política">
        <P>
          Esta política pode ser atualizada para refletir mudanças no serviço,
          na legislação ou nas nossas práticas de privacidade. Sempre que
          ocorrerem mudanças relevantes, avisaremos por e-mail e WhatsApp
          antes que entrem em vigor. A data da última atualização aparece no
          topo desta página.
        </P>
      </Section>

      <Section
        id="contato"
        title="13. Encarregado de Dados (DPO) e contato"
      >
        <P>Para qualquer dúvida, solicitação ou exercício de direitos:</P>
        <UL>
          <LI>
            <strong>E-mail do Encarregado:</strong>{" "}
            <a
              href="mailto:dpo@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              dpo@institutonovamedida.com.br
            </a>
          </LI>
          <LI>
            <strong>E-mail geral:</strong>{" "}
            <a
              href="mailto:contato@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              contato@institutonovamedida.com.br
            </a>
          </LI>
          <LI>
            <strong>Endereço postal:</strong> [a preencher].
          </LI>
        </UL>
        <Aside variant="warning">
          Esta política foi redigida em linguagem clara e tem caráter
          informativo geral. Para situações específicas — incluindo
          requisições judiciais, denúncias e exercício formal de direitos —
          mantenha o registro por escrito com nosso Encarregado.
        </Aside>
      </Section>
    </LegalShell>
  );
}
