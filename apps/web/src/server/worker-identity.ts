import identity from "../../worker-identity.json";

// Identity keys preserve literal types across JSON imports. Each record has one
// deployed name; its queue value is the existing checkout-local suffix.
function identityKey<T extends object>(record: T): keyof T & string {
  const keys = Object.keys(record);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !Object.hasOwn(record, key))
    throw new Error("Worker identity must contain exactly one name");
  // SAFETY: validated own JSON key; Object.keys otherwise widens it to string.
  return key as keyof T & string;
}

export const QUEUE_NAMES = {
  background: identityKey(identity.queues.background),
  telemetry: identityKey(identity.queues.telemetry),
  purchaseAgent: identityKey(identity.queues.purchaseAgent),
};

export const CRON_SCHEDULES = {
  backgroundRecovery: identityKey(identity.crons.backgroundRecovery),
  dailyMaintenance: identityKey(identity.crons.dailyMaintenance),
};

export function localQueueNames(devId: string) {
  const workerName = `cubby-dev-${devId}`;
  return {
    background: `${workerName}-${identity.queues.background[QUEUE_NAMES.background]}`,
    telemetry: `${workerName}-${identity.queues.telemetry[QUEUE_NAMES.telemetry]}`,
    purchaseAgent: `${workerName}-${identity.queues.purchaseAgent[QUEUE_NAMES.purchaseAgent]}`,
  };
}
