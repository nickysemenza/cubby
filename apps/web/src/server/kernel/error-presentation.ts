import { MACHINERY_RAW_ERROR_BYTES } from "@cubby/schemas/kernel/machinery";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";

/** Credential scrubbing precedes the UTF-8 diagnostic byte cap. */
export const machineryErrorText = (raw: string | null | undefined) => {
  if (!raw) return null;
  const scrubbed = scrubErrorMessage(raw);
  const bytes = new TextEncoder().encode(scrubbed);
  return bytes.byteLength <= MACHINERY_RAW_ERROR_BYTES
    ? scrubbed
    : new TextDecoder().decode(bytes.slice(0, MACHINERY_RAW_ERROR_BYTES));
};
