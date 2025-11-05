import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: ["src/server/services/**/*.ts", "src/server/services/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "~/server/repo/database-helpers",
                "~/server/repo/database-helpers*",
                "~/server/db/schema",
                "~/server/db/schema*",
              ],
              message:
                "Services cannot access DB helpers or schema directly. Use repo functions instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/server/api/**/*.ts", "src/server/api/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/server/db/schema", "~/server/db/schema*"],
              message:
                "Routers cannot access DB schema directly. Use services/repos instead.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "wasm/**",
  ]),
]);

export default eslintConfig;
