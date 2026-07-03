import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/functions/**/*.{test,spec}.ts"],
  },
  resolve: {
    alias: {
      // As edge functions importam jszip via esm.sh (Deno); nos testes a
      // mesma URL resolve para o pacote npm local.
      "https://esm.sh/jszip@3.10.1": "jszip",
    },
  },
});
