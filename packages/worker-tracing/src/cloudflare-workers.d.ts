// Minimal ambient declaration of the `cloudflare:workers` `tracing` surface so
// this package is self-contained — consumers don't need `@cloudflare/workers-types`
// loaded globally for it to typecheck. Mirrors the `Tracing`/`Span` shape in
// @cloudflare/workers-types (which the workers themselves run against at runtime).
declare module "cloudflare:workers" {
  interface CfSpan {
    setAttribute(key: string, value?: boolean | number | string): void;
  }
  export const tracing: {
    enterSpan<T, A extends unknown[]>(
      name: string,
      callback: (span: CfSpan, ...args: A) => T,
      ...args: A
    ): T;
  };
}
