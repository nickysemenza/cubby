import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";

/**
 * The wire contract every Start operation shares, owned by neither side.
 *
 * `start-operation.server.ts` produces these shapes and the browser transport
 * consumes them, so this module must stay client-safe: types only, no server
 * bindings, no Query-integration imports. The server previously imported the
 * contract *from* the Query integration layer, which pointed the dependency
 * backwards — server code must never depend on a browser transport module.
 */

export type PublicStartValidationIssue = {
  code: string;
  path: Array<string | number>;
  message: string;
};

export type PublicStartOperationError = {
  message: string;
  code: string;
  reason?: string;
  /** Correlates this failed request with server-side traces and Sentry. */
  requestId?: string;
  blockers?: PublicImpactItem[];
  validationIssues?: PublicStartValidationIssue[];
};

export type StartOperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicStartOperationError };
