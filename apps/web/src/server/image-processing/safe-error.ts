import { z } from "zod";
/** Provider/storage errors can contain signed request URLs; never persist them. */
export function safeImageProcessingError(error: unknown): string {
  const parsed = z.instanceof(Error).safeParse(error);
  const message = parsed.success
    ? parsed.data.message
    : "Image processing failed";
  return (
    message
      .replace(/https?:\/\/[^\s<>"']+/gi, "[URL omitted]")
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(
        /((?:api[_-]?key|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      )
      .slice(0, 1000) || "Image processing failed"
  );
}
