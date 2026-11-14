import { createHash } from "node:crypto";

/** Preserve persisted JSON fingerprint bytes without a separate encoding buffer. */
export const digestValue = <T extends object>(value: T) => {
  const serialized = JSON.stringify(value);
  return createHash("sha256")
    .update(serialized ?? "")
    .digest("hex");
};

/** The caller emits validated canonical JSON without splitting surrogate pairs. */
export const digestCanonicalEvidenceStream = (
  writeEvidence: (write: (fragment: string) => void) => void,
) => {
  const hash = createHash("sha256");
  let buffered = '{"evidence":"';
  writeEvidence((fragment) => {
    // Escaping is additive across fragments with complete Unicode characters.
    const escaped = JSON.stringify(fragment).slice(1, -1);
    if (buffered.length + escaped.length > 32_768) {
      hash.update(buffered);
      buffered = escaped;
    } else buffered += escaped;
  });
  hash.update(buffered);
  hash.update('"}');
  return hash.digest("hex");
};
