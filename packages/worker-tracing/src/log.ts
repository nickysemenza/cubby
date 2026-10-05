/**
 * A minimal structured logger: a level, a scope that prefixes the message, and
 * a flat bag of fields passed as the trailing `console` argument (which
 * Workers Observability indexes as structured data). It exists so a service
 * client states `logger.warn("lookup failed", { upc, status })` once instead
 * of hand-formatting `[Scope] ...` strings at every site.
 *
 * Native Error diagnostics are made JSON-visible and credential-shaped values
 * are scrubbed before they reach the sink.
 */

import { serializeLogFields } from "./log-diagnostics";
import { scrubCredentialValues } from "./scrub-error-message";

export { originalLoggedError } from "./log-diagnostics";

export type LogLevel = "debug" | "info" | "warn" | "error";

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- free-form diagnostic fields; the sink only serializes them.
type LogFields = Record<string, unknown>;
type LogSink = Pick<Console, LogLevel>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger whose every entry also carries `fields`. */
  child(fields: LogFields): Logger;
}

const emit = (
  sink: LogSink,
  scope: string,
  bound: LogFields,
  level: LogLevel,
  message: string,
  fields: LogFields | undefined,
) => {
  const merged = { ...bound, ...fields };
  const text = scrubCredentialValues(`[${scope}] ${message}`);
  if (Object.keys(merged).length === 0) sink[level](text);
  else sink[level](text, serializeLogFields(merged));
};

/** `sink` defaults to the global `console`, read at call time so tests can spy. */
export function createLogger(
  scope: string,
  bound: LogFields = {},
  sink?: LogSink,
): Logger {
  const target = () => sink ?? console;
  const log =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void =>
      emit(target(), scope, bound, level, message, fields);
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields) => createLogger(scope, { ...bound, ...fields }, sink),
  };
}
