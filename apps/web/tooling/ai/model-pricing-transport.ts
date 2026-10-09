/** Catalog reads keep their official origin and do not count as inference. */
export function isModelPricingRead(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.origin === "https://models.dev" &&
    url.pathname === "/api.json"
  );
}
