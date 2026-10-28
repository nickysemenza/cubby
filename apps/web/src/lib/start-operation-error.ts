import { z } from "zod";

import type { PublicStartOperationError } from "~/server/operation-runtime/start-operation.contract";

/**
 * Every client-side operation failure: a server refusal, and a transport or
 * protocol failure described in the same public error shape.
 */
export class StartOperationError extends Error {
  readonly data: Omit<PublicStartOperationError, "message">;
  readonly requestId: string | undefined;

  constructor(error: PublicStartOperationError, options?: ErrorOptions) {
    super(error.message, options);
    this.name = "StartOperationError";
    this.requestId = error.requestId;
    const { message: _message, ...data } = error;
    this.data = data;
  }
}

const schemaError = (
  operation: string,
  stage: "input" | "output",
  error: z.ZodError,
) =>
  new StartOperationError(
    {
      code: stage === "input" ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
      reason:
        stage === "input"
          ? "INVALID_OPERATION_INPUT"
          : "INVALID_OPERATION_OUTPUT",
      message: `${operation} ${stage} failed validation`,
      validationIssues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.filter(
          (key): key is string | number => typeof key !== "symbol",
        ),
        message: issue.message,
      })),
    },
    { cause: error },
  );

/**
 * Parse an operation input on the client. Synchronous, so a call still reaches
 * its transport within the caller's turn (server render relies on it).
 */
export function parseOperationInput<T>(operation: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof z.ZodError)
      throw schemaError(operation, "input", error);
    throw error;
  }
}

/** Parse an operation result or event, which may load its schema lazily. */
export async function parseOperationOutput<T>(
  operation: string,
  parse: () => T | Promise<T>,
): Promise<T> {
  try {
    return await parse();
  } catch (error) {
    if (error instanceof z.ZodError)
      throw schemaError(operation, "output", error);
    throw error;
  }
}
