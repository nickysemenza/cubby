import { env } from "~/env";

const publicOrigin = new URL(env.R2_PUBLIC_URL).origin;

/** Derive the canonical public URL for an R2 object key. */
export const getR2PublicUrl = (key: string): string => `${publicOrigin}/${key}`;

/** Whether a URL belongs to the currently configured public R2 origin. */
export const isOurBucketUrl = (url: string): boolean => {
  try {
    return new URL(url).origin === publicOrigin;
  } catch {
    return false;
  }
};

/** Extract an R2 object key from a URL on the configured public origin. */
export const extractKeyFromUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== publicOrigin || parsed.search || parsed.hash)
    return null;
  const key = parsed.pathname.slice(1);
  return key.length > 0 ? key : null;
};
