import type { Metadata } from "next";
import {
  LegalShell,
  Section,
  P,
  UL,
  LI,
  Aside,
} from "@/components/LegalShell";

export const metadata: Metadata = {
  title: "Sobre o Instituto Nova Medida — quem somos e por que existimos",
  description:
    "O Instituto Nova Medida é uma plataforma brasileira de telessaúde para emagrecimento individualizado, com avaliação médica, prescrição quando indicada e acompanhamento contínuo.",
  alternates: { canonical: "/sobre" },
  robots: { index: true, follow: true },
};

export default function SobrePage() {
  return (
    <LegalShell
      title="Sobre o Instituto"
      intro="Somos uma plataforma brasileira de telessaúde para quem está cansada das promessas vazias do emagrecimento. Nosso compromisso é simples: avaliação médica de verdade, plano individual e acompanhamento que continua depois da consulta."
      updatedAt="19 de abril de 2026"
    >
      <Section id="missao" title="Por que existimos">
        <P>
          A indústria do emagrecimento brasileira vendeu, durante décadas, a
          mesma narrativa: <em>se você não emagrece, é porque não se esforça
          o suficiente</em>. Pesar-se, cortar carboidrato, treinar mais,
          comer menos, repetir até dar certo. Não dá certo — e ainda sobra a
          culpa.
        </P>
        <P>
          A medicina mudou. Hoje sabemos que sobrepeso e obesidade são
          condições clínicas multifatoriais — envolvem genética, hormônios,
          metabolismo, ambiente e comportamento. Existem tratamentos
          cientificamente validados, individuais, com acompanhamento
          contínuo. Mas o acesso a esse cuidado segue caro, fragmentado e,
          para muita gente, distante.
        </P>
        <P>
          O Instituto Nova Medida nasceu para encurtar esse caminho com
          rigor médico, transparência total e o tipo de cuidado que
          continua depois da consulta.
        </P>
      </Section>

      <Section id="como-funciona" title="Como atendemos">
        <P>
          Tudo começa por uma <strong>avaliação médica online</strong>, sem
          compromisso. Você responde a um questionário clínico breve,
          conversa com uma médica por videoconferência segura e recebe uma
          conduta individual.
        </P>
        <P>Daí em diante, o que pode acontecer:</P>
        <UL>
          <LI>
            Se houver indicação clínica, a médica prescreve o tratamento
            mais adequado ao seu caso, com receita digital ICP-Brasil
            válida em todo o país.
          </LI>
          <LI>
            A medicação manipulada (quando aplicável) é preparada por
            farmácia parceira licenciada pela Anvisa e enviada na sua casa.
          </LI>
          <LI>
            O acompanhamento contínuo acontece pelo WhatsApp Business com a
            mesma médica que avaliou você — em conformidade com a Resolução
            CFM nº 2.314/2022.
          </LI>
          <LI>
            Reconsultas periódicas são agendadas conforme a evolução do
            tratamento.
          </LI>
          <LI>
            Se a avaliação concluir que você <strong>não deve</strong> ser
            medicada neste momento, a consulta inicial é gratuita.
          </LI>
        </UL>
      </Section>

      <Section id="valores" title="No que acreditamos">
        <UL>
          <LI>
            <strong>Medicina baseada em evidência.</strong> Tratamento sério
            é aquele que tem estudo, registro e protocolo — não promessa de
            internet.
          </LI>
          <LI>
            <strong>Decisão clínica individual.</strong> Cada corpo é único.
            Quem pode dizer o que serve é a médica que olha para você, com
            seus exames, sua história e seu contexto.
          </LI>
          <LI>
            <strong>Cuidado contínuo.</strong> Emagrecimento não é evento, é
            processo. A consulta é o começo, não o fim.
          </LI>
          <LI>
            <strong>Transparência radical.</strong> Você sabe quanto custa,
            o que está incluso, quem é a sua médica e o que entrega cada
            etapa.
          </LI>
          <LI>
            <strong>Privacidade e dignidade.</strong> Dados de saúde são
            sensíveis. Tratamos os seus com o cuidado que esperamos para os
            nossos.
          </LI>
        </UL>
      </Section>

      <Section id="conformidade" title="Em conformidade com a regulação brasileira">
        <P>
          Operamos como plataforma de telessaúde nos termos da{" "}
          <strong>Lei nº 14.510/2022</strong> (telessaúde) e da{" "}
          <strong>Resolução CFM nº 2.314/2022</strong> (telemedicina). As
          médicas e os médicos parceiros são registrados em seus
          respectivos Conselhos Regionais de Medicina, atuam com autonomia
          técnica e seguem o Código de Ética Médica.
        </P>
        <P>
          Quando há indicação medicamentosa que envolve manipulação,
          observamos a <strong>Nota Técnica Anvisa nº 200/2025</strong>{" "}
          sobre análogos de GLP-1 manipulados. As farmácias parceiras são
          previamente avaliadas quanto à licença sanitária e aos padrões
          mínimos de boas práticas.
        </P>
        <P>
          O tratamento de dados pessoais segue a{" "}
          <strong>Lei Geral de Proteção de Dados (Lei nº 13.709/2018)</strong>
          . Detalhes na nossa{" "}
          <a
            href="/privacidade"
            className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
          >
            Política de Privacidade
          </a>
          .
        </P>
      </Section>

      <Section id="quem-somos" title="Quem somos">
        <P>
          O Instituto Nova Medida é mantido pelo{" "}
          <strong>Instituto Nova Medida Saúde Ltda.</strong> (CNPJ a
          preencher), com sede no Rio de Janeiro, e conta com:
        </P>
        <UL>
          <LI>
            uma <strong>Diretoria Médica</strong> responsável pela curadoria
            clínica, definição de protocolos e auditoria de qualidade do
            atendimento;
          </LI>
          <LI>
            um <strong>corpo de médicas parceiras</strong> com formação em
            endocrinologia, nutrologia e/ou medicina interna, todas com
            CRM ativo;
          </LI>
          <LI>
            uma <strong>equipe de tecnologia</strong> dedicada à
            confiabilidade, segurança e privacidade da plataforma;
          </LI>
          <LI>
            uma <strong>equipe de cuidado</strong> que acompanha pacientes,
            organiza agendamentos e garante que ninguém fique pelo caminho;
          </LI>
          <LI>
            um <strong>Encarregado de Dados (DPO)</strong> dedicado a
            proteger sua privacidade — você fala com ele em{" "}
            <a
              href="mailto:dpo@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              dpo@institutonovamedida.com.br
            </a>
            .
          </LI>
        </UL>
      </Section>

      <Section id="contato" title="Falar com a gente">
        <UL>
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
            <strong>Imprensa:</strong>{" "}
            <a
              href="mailto:imprensa@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              imprensa@institutonovamedida.com.br
            </a>
          </LI>
          <LI>
            <strong>Para médicas que querem ser parceiras:</strong>{" "}
            <a
              href="mailto:medicas@institutonovamedida.com.br"
              className="text-sage-700 hover:text-sage-800 underline underline-offset-2"
            >
              medicas@institutonovamedida.com.br
            </a>
          </LI>
        </UL>
        <Aside>
          <strong>Em caso de emergência</strong>, ligue 192 (SAMU) ou
          procure o pronto-socorro mais próximo. Os canais do Instituto não
          atendem urgências.
        </Aside>
      </Section>
    </LegalShell>
  );
}
