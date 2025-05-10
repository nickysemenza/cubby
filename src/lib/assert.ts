/**
 * Helper function for exhaustiveness checking in TypeScript
 *
 * Use this in default cases of switch statements to ensure all cases are handled.
 * TypeScript will give a compile-time error if a case is missing.
 *
 * @example
 * switch (value) {
 *   case "a": return "A";
 *   case "b": return "B";
 *   default: return assertNever(value); // Will error if value can be something other than "a" or "b"
 * }
 */
export function assertNever(value: never): never {
  throw new Error(
    `Unhandled discriminated union member: ${JSON.stringify(value)}`,
  );
}
