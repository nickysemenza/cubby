// Keep registry metadata independent of the dialogs that import the registry.
export const trackerEntities = ["expense", "task"] as const;
export type TrackerEntity = (typeof trackerEntities)[number];
