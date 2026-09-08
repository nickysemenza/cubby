/** Built previews on loopback are local executions, even with production JS. */
export function sentryEnvironment(
  origin: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!origin) return fallback;
  try {
    const hostname = new URL(origin).hostname.replace(/\.$/, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    ) {
      return fallback === "test" ? "test" : "development";
    }
  } catch {
    // Relative or malformed URLs cannot establish a runtime environment.
  }
  return fallback;
}
