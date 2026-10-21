import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Declaration source facts available before compiler/schema initialization. */
export const SPEC_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/schemas/src/entity-definitions",
);

export class EntityDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityDeclarationError";
  }
}
