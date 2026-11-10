CREATE TABLE "CoordinatorTurn" (
	"runId" uuid PRIMARY KEY,
	"held" boolean NOT NULL,
	"leaseToken" uuid NOT NULL,
	"leaseExpiresAt" timestamp NOT NULL,
	"askedAt" timestamp DEFAULT now() NOT NULL
);
