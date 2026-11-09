export function localGoogleProviderOrigin(mode: string, origin?: string) {
  if (mode !== "true" || !origin) return undefined;
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("E2E Google provider must be a loopback HTTP origin");
  return url.origin;
}
