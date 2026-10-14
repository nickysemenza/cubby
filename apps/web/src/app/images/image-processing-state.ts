const STATE_LABEL: Readonly<Record<string, string>> = {
  ready: "Completed",
  skipped: "Skipped",
  pending: "Queued",
  leased: "Processing",
  waiting_for_device: "Waiting for Apple",
  failed: "Failed",
};

/** An image processing state as the Image page words it. */
export const workStateLabel = (state: string) =>
  STATE_LABEL[state] ?? state.replaceAll("_", " ");
