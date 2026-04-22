/**
 * Smoke test permanente — trip-wire regulatório para páginas públicas.
 *
 * Contexto (PR-065 · D-073 · audit [7.6]):
 *   CFM 2.336/2023 Art. 19 veda publicidade de medicamento direta ao leigo.
 *   A violação é objetiva: se uma página pública (sem autenticação) exibe
 *   nome comercial ou princípio ativo específico de um fármaco prescrito,
 *   é infração — mesmo que o contexto seja "informativo".
 *
 *   Esse teste varre os arquivos-fonte das rotas e componentes que compõem
 *   as páginas públicas (não autenticadas) e falha o build se detectar
 *   qualquer nome proibido. A lista é deliberadamente pequena (nomes
 *   comerciais + princípios ativos) para evitar falsos positivos, e inclui
 *   linguagem que aparece em peças promocionais médicas.
 *
 *   Contexto autenticado (`/paciente/...`, `/medico/...`, `/admin/...`)
 *   está fora do escopo: lá existe relação médico-paciente estabelecida e
 *   a vedação de Art. 19 não se aplica.
 *
 *   "GLP-1" é classe terapêutica (não nome comercial), e a menção atual
 *   em `/sobre` e `/termos` está em contexto regulatório explícito
 *   (citando a Nota Técnica Anvisa 200/2025). É permitido.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Termos proibidos: nomes comerciais + princípios ativos específicos.
// Case-insensitive. Word boundaries aplicados no regex compilado abaixo.
const FORBIDDEN_TERMS = [
  // Princípios ativos (DCB/INN).
  "tirzepatida",
  "tirzepatide",
  "semaglutida",
  "semaglutide",
  "liraglutida",
  "liraglutide",
  "dulaglutida",
  "dulaglutide",
  "exenatida",
  "exenatide",
  // Nomes comerciais.
  "ozempic",
  "mounjaro",
  "monjaro",
  "wegovy",
  "rybelsus",
  "saxenda",
  "victoza",
  "trulicity",
  "byetta",
  "bydureon",
];

const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_TERMS.join("|")})\\b`, "i");

/**
 * Rotas públicas: qualquer visitante pode acessar sem autenticação.
 * Páginas com gate server-side (`/checkout/[plano]`, `/agendar/[plano]`)
 * entram aqui defensivamente — mesmo com feature-flag desabilitada em
 * produção, o source é lido pelo compilador e qualquer constante string
 * no código poderia vazar por SSR error / logs.
 */
const PUBLIC_PAGE_PATHS: readonly string[] = [
  "src/app/page.tsx",
  "src/app/sobre/page.tsx",
  "src/app/planos/page.tsx",
  "src/app/termos/page.tsx",
  "src/app/privacidade/page.tsx",
  "src/app/checkout/[plano]/page.tsx",
  "src/app/checkout/sucesso/page.tsx",
  "src/app/checkout/aguardando/page.tsx",
  "src/app/agendar/[plano]/page.tsx",
  "src/app/paciente/login/page.tsx",
  "src/app/medico/login/page.tsx",
  "src/app/admin/login/page.tsx",
];

/**
 * Diretórios de componentes públicos.
 * `src/components/*.tsx` é compartilhado entre home pública e fluxos
 * autenticados, mas a superfície de risco é idêntica: qualquer string
 * literal em componente importado pela home pode renderizar na home.
 */
const PUBLIC_COMPONENT_DIRS: readonly string[] = [
  "src/components",
];

function collectTsxFiles(absDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir)) {
    const full = path.join(absDir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsxFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function checkFileForForbiddenTerms(absPath: string): string[] {
  const source = readFileSync(absPath, "utf8");
  const lines = source.split(/\r?\n/);
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Ignora linhas claramente de comentário sobre o próprio guard-rail
    // (esse arquivo lista os termos; outras docs podem explicar motivos).
    if (line.includes("FORBIDDEN_TERMS") || line.includes("PR-065")) {
      continue;
    }
    const m = line.match(FORBIDDEN_RE);
    if (m) {
      const rel = path.relative(REPO_ROOT, absPath);
      hits.push(`  ${rel}:${i + 1}  →  ${line.trim()}`);
    }
  }
  return hits;
}

describe("public pages safety — CFM 2.336/2023 Art. 19 guard (PR-065 · D-073)", () => {
  it("nenhum nome comercial/princípio ativo de medicamento em páginas públicas", () => {
    const allFiles: string[] = [];
    for (const rel of PUBLIC_PAGE_PATHS) {
      allFiles.push(path.join(REPO_ROOT, rel));
    }
    for (const dir of PUBLIC_COMPONENT_DIRS) {
      allFiles.push(...collectTsxFiles(path.join(REPO_ROOT, dir)));
    }

    const violations: string[] = [];
    for (const abs of allFiles) {
      violations.push(...checkFileForForbiddenTerms(abs));
    }

    if (violations.length > 0) {
      const banner = [
        "",
        "❌ CFM 2.336/2023 Art. 19 violação detectada em páginas públicas.",
        "",
        "Nome comercial ou princípio ativo de medicamento foi adicionado",
        "a arquivo(s) que compõem superfície pública (sem autenticação).",
        "Isso é publicidade de medicamento direta ao leigo e é infração.",
        "",
        "Arquivos afetados:",
        ...violations,
        "",
        "Como corrigir:",
        "  • Se a informação é necessária, mova-a para rota autenticada",
        "    (`/paciente/...`, `/medico/...`, `/admin/...`).",
        "  • Se a menção é inevitável (ex.: citação regulatória explícita),",
        "    use a classe terapêutica (\"análogos de GLP-1\") em vez do nome",
        "    comercial ou princípio ativo específico.",
        "",
        "Contexto: src/app/public-pages-safety.test.ts",
        "",
      ].join("\n");
      throw new Error(banner);
    }

    expect(violations.length).toBe(0);
  });

  it("regex de detecção cobre nomes comerciais e princípios ativos alvo", () => {
    const samples = [
      "Tirzepatida",
      "Semaglutida manipulada",
      "receita de Ozempic",
      "Wegovy 2.4mg",
      "liraglutide injection",
      "mounjaro pen",
    ];
    for (const s of samples) {
      expect(FORBIDDEN_RE.test(s)).toBe(true);
    }
  });

  it("regex não dispara em termos permitidos (classe terapêutica, prefixo)", () => {
    const permitted = [
      "análogos de GLP-1",
      "GLP-1",
      "apetite e metabolismo",
      "manipulação farmacêutica",
      "obesidade e sobrepeso",
      "acompanhamento clínico",
      "Nota Técnica Anvisa nº 200/2025",
      "Resolução CFM nº 2.314/2022",
    ];
    for (const s of permitted) {
      expect(FORBIDDEN_RE.test(s)).toBe(false);
    }
  });
});
