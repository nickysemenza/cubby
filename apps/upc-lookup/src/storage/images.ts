import type { Env } from '../types';

const TIMEOUT_MS = 10000;

/**
 * Download an image from an external URL and store it in R2.
 * Returns the R2 object key if successful, null otherwise.
 * Non-blocking - failures don't throw, just return null.
 */
export async function storeImage(
  upc: string,
  imageUrl: string,
  env: Env
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`Failed to fetch image: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const ext = getExtensionFromContentType(contentType);
    const key = `images/${upc}.${ext}`;

    await env.IMAGES.put(key, response.body, {
      httpMetadata: { contentType },
    });

    return key;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('Image fetch timeout');
    } else {
      console.error('Image storage error:', error);
    }
    return null;
  }
}

/**
 * Get the URL for an image stored in R2.
 * When baseUrl is provided, returns a full URL (for API responses).
 * When baseUrl is omitted, returns a relative path (for HTML rendering).
 */
export function getImageUrl(imageKey: string, baseUrl?: string): string {
  const path = `/${imageKey}`;
  if (baseUrl) {
    return `${baseUrl}${path}`;
  }
  return path;
}

function getExtensionFromContentType(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}
