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
  title: "Termos de Uso — Instituto Nova Medida",
  description:
    "Termos e condições de uso da plataforma de telessaúde do Instituto Nova Medida. Direitos, deveres, limitações e responsabilidades de pacientes, médicas e da plataforma.",
  alternates: { canonical: "/termos" },
  robots: { index: true, follow: true },
};

const SECTIONS = [
  { id: "objeto", label: "Objeto e aceitação" },
  { id: "natureza", label: "Natureza do serviço" },
  { id: "elegibilidade", label: "Quem pode usar" },
  { id: "cadastro", label: "Cadastro, conta e responsabilidade" },
  { id: "consulta", label: "Avaliação médica online" },
  { id: "prescricao", label: "Prescrição e medicamentos" },
  { id: "pagamento", label: "Planos, pagamentos e cancelamento" },
  { id: "acompanhamento", label: "Acompanhamento via WhatsApp" },
  { id: "uso-aceitavel", label: "Uso aceitável" },
  { id: "limitacao", label: "Limitação de responsabilidade" },
  { id: "propriedade", label: "Propriedade intelectual" },
  { id: "vigencia", label: "Vigência e alterações" },
  { id: "lei", label: "Lei aplicável e foro" },
  { id: "contato", label: "Contato" },
];

export default function TermosPage() {
  return (
    <LegalShell
      title="Termos de Uso"
      intro="Estes termos regulam o uso da plataforma do Instituto Nova Medida. Foram escritos em linguagem direta porque queremos que você entenda exatamente o que está contratando."
      updatedAt="19 de abril de 2026"
    >
      <TOC items={SECTIONS} />

      <Section id="objeto" title="1. Objeto e aceitação">
        <P>
          O <strong>Instituto Nova Medida Saúde Ltda.</strong> (CNPJ a
          preencher), doravante &quot;Instituto&quot;, &quot;plataforma&quot;
          ou &quot;nós&quot;, oferece um serviço de telessaúde voltado a
          avaliação médica online, prescrição individualizada quando indicada
          e acompanhamento clínico contínuo, especialmente para pessoas com
          sobrepeso ou obesidade.
        </P>
        <P>
          Ao utilizar nosso site, preencher o questionário de avaliação,
          contratar um plano ou interagir conosco por qualquer canal, você
          declara que <strong>leu, entendeu e concorda</strong> com estes
          Termos e com a nossa{" "}
          <a
            href="/privacidade"
            className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
          >
            Política de Privacidade
          </a>
          .
        </P>
      </Section>

      <Section id="natureza" title="2. Natureza do serviço">
        <P>
          O Instituto Nova Medida é uma{" "}
          <strong>plataforma de tecnologia em saúde</strong> que conecta
          pacientes a médicas e médicos devidamente registrados em seus
          respectivos Conselhos Regionais de Medicina (CRMs).
        </P>
        <P>
          O atendimento médico é realizado por profissionais autônomos
          parceiros, em conformidade com:
        </P>
        <UL>
          <LI>
            <strong>Lei nº 14.510/2022</strong> — Lei da Telessaúde no Brasil;
          </LI>
          <LI>
            <strong>Resolução CFM nº 2.314/2022</strong> — regulamenta a
            telemedicina;
          </LI>
          <LI>
            <strong>Resolução CFM nº 1.821/2007</strong> — guarda de
            prontuário;
          </LI>
          <LI>
            <strong>Código de Ética Médica vigente</strong>;
          </LI>
          <LI>
            <strong>Nota Técnica Anvisa nº 200/2025</strong> — sobre
            manipulação de medicamentos análogos de GLP-1 (quando aplicável).
          </LI>
        </UL>
        <Aside>
          A relação clínica se estabelece entre <strong>você e a médica</strong>{" "}
          que realiza seu atendimento. O Instituto fornece a infraestrutura,
          a logística e o acompanhamento operacional — mas não substitui o
          juízo clínico individual.
        </Aside>
      </Section>

      <Section id="elegibilidade" title="3. Quem pode usar a plataforma">
        <P>Para utilizar o serviço, você precisa:</P>
        <UL>
          <LI>
            Ter <strong>18 anos ou mais</strong>;
          </LI>
          <LI>
            Ser plenamente capaz, nos termos do Código Civil;
          </LI>
          <LI>
            Residir no Brasil;
          </LI>
          <LI>
            Fornecer informações <strong>verdadeiras, completas e atuais</strong>{" "}
            no questionário de avaliação. Omitir condições clínicas
            relevantes pode invalidar a indicação médica e gerar riscos à sua
            saúde.
          </LI>
        </UL>
      </Section>

      <Section id="cadastro" title="4. Cadastro, conta e responsabilidade">
        <P>
          Você é responsável por todas as informações fornecidas e pela
          segurança das credenciais de acesso (telefone, e-mail, senhas
          eventuais). Se identificar uso indevido da sua conta, comunique a
          gente imediatamente.
        </P>
        <P>
          Reservamo-nos o direito de suspender ou encerrar contas com indícios
          de fraude, falsidade ideológica ou uso em desacordo com estes
          Termos.
        </P>
      </Section>

      <Section id="consulta" title="5. Avaliação médica online">
        <P>
          A consulta ocorre por <strong>videoconferência segura</strong>
          dentro da nossa plataforma, com criptografia e identificação do
          profissional.
        </P>
        <H3>5.1. Antes da consulta</H3>
        <P>
          Você responde a um questionário clínico inicial, que orienta a
          análise médica. Quanto mais preciso for, melhor a avaliação.
        </P>
        <H3>5.2. Durante a consulta</H3>
        <P>
          A médica avalia sua história clínica, examina dados informados,
          esclarece dúvidas e decide a conduta:
        </P>
        <UL>
          <LI>solicitar exames complementares;</LI>
          <LI>indicar tratamento medicamentoso individualizado;</LI>
          <LI>indicar acompanhamento sem medicamento; ou</LI>
          <LI>
            <strong>não indicar</strong> qualquer tratamento medicamentoso —
            decisão exclusivamente clínica que respeitamos integralmente.
          </LI>
        </UL>
        <H3>5.3. Se não houver indicação medicamentosa</H3>
        <P>
          Se a médica concluir que você <strong>não deve</strong> ser medicada
          ou medicado neste momento, a consulta inicial é{" "}
          <strong>gratuita</strong> e nenhum valor é cobrado por ela.
        </P>
      </Section>

      <Section id="prescricao" title="6. Prescrição e medicamentos">
        <P>
          Quando indicada, a prescrição é emitida{" "}
          <strong>digitalmente, com assinatura ICP-Brasil</strong>, válida em
          todo o território nacional.
        </P>
        <P>
          A medicação manipulada (quando for o caso) é preparada por{" "}
          <strong>farmácias parceiras devidamente licenciadas pela
          Anvisa</strong> e enviada diretamente ao endereço informado por
          você. O Instituto não fabrica, não armazena e não comercializa
          medicamentos.
        </P>
        <H3>Sua corresponsabilidade</H3>
        <UL>
          <LI>
            Seguir <strong>rigorosamente</strong> a posologia prescrita.
          </LI>
          <LI>
            <strong>Não compartilhar</strong> a medicação com terceiros — a
            indicação é estritamente individual.
          </LI>
          <LI>
            Comunicar imediatamente sua médica em caso de efeito adverso,
            reação alérgica ou qualquer alteração relevante de saúde.
          </LI>
          <LI>
            Manter exames e reavaliações em dia.
          </LI>
        </UL>
        <Aside variant="warning">
          <strong>Importante:</strong> tratamento farmacológico para
          emagrecimento exige acompanhamento contínuo. Interromper a medicação
          ou alterar doses por conta própria pode comprometer resultados e
          gerar efeitos indesejados.
        </Aside>
      </Section>

      <Section
        id="pagamento"
        title="7. Planos, pagamentos e cancelamento"
      >
        <P>
          Os valores, formas de pagamento e composição de cada plano estão
          descritos na página de planos e na sua proposta personalizada após
          a consulta.
        </P>
        <UL>
          <LI>
            <strong>Formas de pagamento:</strong> PIX, boleto e cartão de
            crédito (parcelamento somente no cartão, conforme regras
            apresentadas no checkout).
          </LI>
          <LI>
            <strong>Processador:</strong> Asaas. Não armazenamos número
            completo de cartão.
          </LI>
          <LI>
            <strong>Recibos:</strong> emitidos eletronicamente para o e-mail
            cadastrado.
          </LI>
        </UL>
        <H3>7.1. Direito de arrependimento</H3>
        <P>
          Conforme o art. 49 do Código de Defesa do Consumidor (CDC), você
          tem o direito de se arrepender em até <strong>7 dias corridos</strong>{" "}
          a contar da assinatura do contrato, sem necessidade de
          justificativa, desde que <strong>nenhum medicamento manipulado
          tenha sido produzido sob sua prescrição</strong>. Após o início da
          manipulação, a medicação é personalizada e não pode ser revendida,
          sendo o reembolso parcial conforme detalhado na proposta de plano.
        </P>
        <H3>7.2. Cancelamento</H3>
        <P>
          Como o plano contempla a entrega completa do tratamento prescrito
          no início, o cancelamento durante o curso só pode interromper{" "}
          <strong>cobranças futuras</strong> ainda não geradas, sem reembolso
          retroativo de doses já manipuladas.
        </P>
      </Section>

      <Section
        id="acompanhamento"
        title="8. Acompanhamento via WhatsApp"
      >
        <P>
          Após a consulta inicial, o acompanhamento contínuo (checagens
          periódicas, dúvidas pontuais, registro de evolução) ocorre por{" "}
          <strong>WhatsApp Business</strong>, em conformidade com a Resolução
          CFM nº 2.314/2022.
        </P>
        <P>
          O WhatsApp <strong>não substitui consulta formal</strong> em casos
          de:
        </P>
        <UL>
          <LI>nova queixa clínica relevante;</LI>
          <LI>efeitos adversos significativos;</LI>
          <LI>mudança importante de conduta;</LI>
          <LI>renovação periódica de prescrição.</LI>
        </UL>
        <P>
          Nessas situações, você será orientada a agendar nova consulta por
          videoconferência.
        </P>
        <Aside variant="warning">
          <strong>Em emergências, ligue 192 (SAMU)</strong> ou procure
          imediatamente o pronto-socorro mais próximo. O WhatsApp do
          Instituto não é canal de urgência.
        </Aside>
      </Section>

      <Section id="uso-aceitavel" title="9. Uso aceitável">
        <P>Você concorda em <strong>não</strong>:</P>
        <UL>
          <LI>
            usar a plataforma para qualquer finalidade ilícita, fraudulenta ou
            que viole direitos de terceiros;
          </LI>
          <LI>
            tentar obter prescrição mediante informação falsa ou simulação de
            sintomas;
          </LI>
          <LI>
            revender, redistribuir ou ceder medicamentos prescritos a você;
          </LI>
          <LI>
            tentar acessar áreas restritas, contornar medidas de segurança ou
            extrair dados em massa do site;
          </LI>
          <LI>
            ofender, ameaçar ou desrespeitar profissionais e equipe de
            atendimento.
          </LI>
        </UL>
        <P>
          Violações podem resultar em suspensão imediata, encerramento do
          contrato e responsabilização civil e criminal.
        </P>
      </Section>

      <Section
        id="limitacao"
        title="10. Limitação de responsabilidade"
      >
        <P>
          O Instituto se compromete a manter a plataforma operacional, segura
          e em conformidade. Ainda assim, <strong>não nos responsabilizamos
          por</strong>:
        </P>
        <UL>
          <LI>
            falhas decorrentes de força maior, interrupções de provedores
            terceiros, instabilidade de conexão da sua parte;
          </LI>
          <LI>
            danos resultantes de informações falsas ou incompletas fornecidas
            por você;
          </LI>
          <LI>
            uso indevido de medicamentos contrariando a prescrição médica;
          </LI>
          <LI>
            decisões clínicas individuais das médicas e médicos parceiros, que
            atuam com autonomia técnica nos termos da legislação médica.
          </LI>
        </UL>
        <P>
          A responsabilidade do Instituto, quando cabível, limita-se aos
          valores efetivamente pagos pelo serviço relacionado ao evento, salvo
          em casos de dolo ou culpa grave comprovados.
        </P>
      </Section>

      <Section id="propriedade" title="11. Propriedade intelectual">
        <P>
          Todo o conteúdo deste site — marca, identidade visual, textos,
          imagens, layout, código-fonte e bancos de dados estruturados —
          pertence ao Instituto Nova Medida ou está licenciado a ele.
          Reprodução, comercialização ou uso fora do contexto da plataforma
          exige autorização prévia e expressa.
        </P>
      </Section>

      <Section id="vigencia" title="12. Vigência e alterações">
        <P>
          Estes Termos vigoram por prazo indeterminado. Podem ser atualizados
          a qualquer momento — quando isso ocorrer, avisaremos por e-mail e
          WhatsApp e indicaremos a nova data de vigência. O uso continuado da
          plataforma após a data de vigência implica aceitação das mudanças.
        </P>
      </Section>

      <Section id="lei" title="13. Lei aplicável e foro">
        <P>
          Estes Termos são regidos pela legislação brasileira. Eventuais
          controvérsias serão dirimidas no foro do <strong>domicílio do
          consumidor</strong>, conforme o art. 101, I do Código de Defesa do
          Consumidor.
        </P>
      </Section>

      <Section id="contato" title="14. Contato">
        <UL>
          <LI>
            <strong>E-mail:</strong>{" "}
            <a
              href="mailto:contato@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              contato@institutonovamedida.com.br
            </a>
          </LI>
          <LI>
            <strong>Encarregado de Dados (DPO):</strong>{" "}
            <a
              href="mailto:dpo@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              dpo@institutonovamedida.com.br
            </a>
          </LI>
        </UL>
      </Section>
    </LegalShell>
  );
}
