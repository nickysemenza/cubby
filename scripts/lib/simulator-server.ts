export function localSimulatorServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Simulator server must be a loopback HTTP origin with an explicit port.",
    );
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Simulator server must be a loopback HTTP origin with an explicit port.",
    );
  return url.origin;
}
