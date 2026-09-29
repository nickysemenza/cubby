import { readStartOperationTraceContext } from "./start-operation-observability";

export function labelStartRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestInfo | URL {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const context = readStartOperationTraceContext(headers);
  if (!context) return input;
  const original = input instanceof Request ? input.url : String(input);
  const url = new URL(original, "https://start.invalid");
  if (!url.pathname.startsWith("/_serverFn/")) return input;
  url.searchParams.set("operation", context.operation);
  if (context.entity) url.searchParams.set("entity", context.entity);
  else url.searchParams.delete("entity");
  if (input instanceof Request) return new Request(url, input);
  return original.startsWith("/")
    ? `${url.pathname}${url.search}${url.hash}`
    : url;
}
