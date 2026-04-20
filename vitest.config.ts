/**
 * Vitest config — Instituto Nova Medida (D-038).
 *
 * Escopo: testes unitários das libs críticas em `src/lib/*` que tocam
 * dinheiro, confiabilidade e refunds. Sem testes de componentes React
 * nem E2E nesta primeira versão — o foco é travar regressão nos
 * caminhos que, se quebrarem, causam dano financeiro ou operacional.
 *
 * Supabase é mockado via `test/mocks/supabase.ts`. Nada de DB real
 * aqui — testes precisam rodar offline e em segundos.
 */

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", ".next"],
    clearMocks: true,
    testTimeout: 5000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
