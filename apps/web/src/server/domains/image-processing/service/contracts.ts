/** One device attempt's lease, whether a wakeup or a device's pull claimed it. */
export const COMPANION_LEASE_MS = 5 * 60_000;

/** The doorbell that tells companions claimable work may exist. */
export interface ImageProcessingCompanionRpc {
  /** Returns how many companion subscribers were reached. */
  ring(): Promise<number>;
}
