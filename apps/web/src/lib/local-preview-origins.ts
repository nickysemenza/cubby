/** Exact HTTPS aliases for a checkout-local Tailscale Serve proxy. */
export function localPreviewOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [
    ...new Set(
      value.split(",").map((entry) => {
        const text = entry.trim();
        const url = new URL(text);
        if (
          url.protocol !== "https:" ||
          !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/u.test(url.hostname) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash ||
          text.replace(/\/$/u, "") !== url.origin
        )
          throw new Error(
            "CUBBY_DEV_ORIGIN_ALIASES requires exact HTTPS ts.net origins without credentials, paths, queries, or fragments",
          );
        return url.origin;
      }),
    ),
  ];
}

export function isLocalPreviewOrigin(
  requestOrigin: string,
  configuredOrigin: string,
  aliases: string | undefined,
): boolean {
  return (
    requestOrigin === configuredOrigin ||
    localPreviewOrigins(aliases).includes(requestOrigin)
  );
}
