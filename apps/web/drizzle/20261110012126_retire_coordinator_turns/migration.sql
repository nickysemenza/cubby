-- The coordinator turn cap moved into the CoordinatorGate Durable Object (#3899).
-- CoordinatorTurn held only live machinery leases (no member facts, money, evidence
-- or decisions); a lease lost here simply re-queues at the gate.
DROP TABLE IF EXISTS "CoordinatorTurn";
