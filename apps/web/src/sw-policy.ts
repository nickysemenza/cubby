export function isBypassedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/trpc/") ||
    pathname === "/trpc"
  );
}

export function isCriticalPrecacheUrl(url: string): boolean {
  return (
    url === "/offline.html" || url.endsWith(".css") || url.endsWith(".wasm")
  );
}
