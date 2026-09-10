/** Generated storage definitions participate in both database template hashes.
 * Omitting them reuses a database whose columns no longer match the model. */
export const schemaTemplateInputs = [
  "./src/server/db/schema.ts",
  "./src/server/db/auth.schema.ts",
  "./src/server/db/generated/**/*.ts",
];
