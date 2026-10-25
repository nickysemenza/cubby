/** The doorbell that tells companions claimable work may exist. */
export interface ImageProcessingCompanionRpc {
  /** Returns how many companion subscribers were reached. */
  ring(): Promise<number>;
}
