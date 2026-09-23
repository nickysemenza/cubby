/** Simulator E2E may create and drop databases only on Cubby's local PostgreSQL port. */
export function assertSimulatorAdminUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "postgresql:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.username !== "postgres" ||
    url.password !== "password" ||
    url.pathname !== "/postgres" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(
      "Simulator E2E requires the exact local PostgreSQL admin target on port 55432",
    );
  return url;
}
