import { scrubCredentialValues } from "./scrub-error-message";

/* oxlint-disable anti-slop/no-runtime-typeof -- logging is the serialization boundary for arbitrary thrown values, including primitives and native errors. */

type SerializedLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializedLogValue[]
  | { [key: string]: SerializedLogValue };

const originalErrors = new WeakMap<object, Error>();

/** Console interception still needs the original exception for Sentry and HTTP diagnostics. */
export function originalLoggedError<T>(value: T): Error | undefined {
  if (value instanceof Error) return value;
  return typeof value === "object" && value !== null
    ? originalErrors.get(value)
    : undefined;
}

const credentialField =
  /^(?:password|passwd|secret|api_?key|token|access_token|refresh_token|authorization|cookie|set-cookie)$/iu;

/** Workers' JSON log sink omits non-enumerable Error properties. */
export function serializeLogFields<T extends object>(value: T): object {
  const ancestors = new Set<object>();
  let remaining = 1000;
  // oxlint-disable-next-line eslint/complexity -- one traversal handles JavaScript value kinds while sharing the entry budget and ancestor cycle guard.
  const visit = <TEntry>(entry: TEntry, depth: number): SerializedLogValue => {
    if (remaining-- <= 0) return "[Truncated]";
    if (typeof entry === "string") return scrubCredentialValues(entry);
    if (typeof entry === "bigint" || typeof entry === "symbol")
      return String(entry);
    if (entry === null) return null;
    if (entry === undefined) return undefined;
    if (typeof entry === "boolean") return entry;
    if (typeof entry === "number")
      return Number.isFinite(entry) ? entry : String(entry);
    if (typeof entry === "function") return "[Function]";
    if (ancestors.has(entry)) return "[Circular]";
    if (depth >= 16) return "[Truncated]";
    ancestors.add(entry);
    try {
      if (entry instanceof Date) return entry.toISOString();
      if (entry instanceof URL) return scrubCredentialValues(entry.href);
      if (Array.isArray(entry)) {
        const result: SerializedLogValue[] = [];
        for (const item of entry) {
          if (remaining <= 0) {
            result.push("[Truncated]");
            break;
          }
          result.push(visit(item, depth + 1));
        }
        return result;
      }
      const keys =
        entry instanceof Error
          ? new Set([
              "name",
              "message",
              "stack",
              ...Object.getOwnPropertyNames(entry),
            ])
          : ownEnumerableKeys(entry);
      const entries: [string, SerializedLogValue][] = [];
      for (const key of keys) {
        if (remaining <= 0) {
          entries.push(["[Truncated]", "[Truncated]"]);
          break;
        }
        if (credentialField.test(key)) {
          remaining--;
          entries.push([key, "[REDACTED]"]);
          continue;
        }
        try {
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Error subclasses carry diagnostic fields not declared on the Error interface; inspect them at the console serialization boundary.
          entries.push([key, visit(Reflect.get(entry, key), depth + 1)]);
        } catch {
          remaining--;
          entries.push([key, "[Unreadable]"]);
        }
      }
      const result = Object.fromEntries(entries);
      if (entry instanceof Error) originalErrors.set(result, entry);
      return result;
    } catch {
      return "[Unreadable]";
    } finally {
      ancestors.delete(entry);
    }
  };
  // The root is the logger's ordinary fields bag, never a throwing proxy.
  return Object(visit(value, 0));
}

function* ownEnumerableKeys<T extends object>(value: T): Generator<string> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield key;
  }
}
