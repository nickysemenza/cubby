CREATE TABLE "Answer" (
	"inputHash" text PRIMARY KEY,
	"feature" text NOT NULL,
	"producer" text NOT NULL,
	"promptVersion" text NOT NULL,
	"output" jsonb NOT NULL,
	"model" text,
	"tier" text,
	"costMicros" bigint,
	"raw" text,
	"askId" uuid,
	"runId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Answer_producer_check" CHECK ("producer" IN ('model', 'embedding', 'image', 'source')),
	CONSTRAINT "Answer_raw_size_check" CHECK ("raw" IS NULL OR octet_length("raw") <= 262144)
);
--> statement-breakpoint
CREATE TABLE "Ask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"inputHash" text NOT NULL CONSTRAINT "Ask_inputHash_unique" UNIQUE,
	"feature" text NOT NULL,
	"producer" text NOT NULL,
	"promptVersion" text NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claimToken" uuid,
	"claimDeadline" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp DEFAULT now() NOT NULL,
	"waitCause" text,
	"lastError" text,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"cancelledAt" timestamp,
	"sentAt" timestamp,
	"answeredAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Ask_state_check" CHECK ("state" IN ('queued', 'sent', 'answered', 'unknown')),
	CONSTRAINT "Ask_producer_check" CHECK ("producer" IN ('model', 'embedding', 'image', 'source')),
	CONSTRAINT "Ask_waitCause_check" CHECK ("waitCause" IS NULL OR "waitCause" IN ('funding', 'provider_capacity', 'in_flight', 'rate_limit', 'device')),
	CONSTRAINT "Ask_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "AskScope" (
	"askId" uuid,
	"scopeKind" text,
	"scopeKey" text,
	"runId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AskScope_pkey" PRIMARY KEY("askId","scopeKind","scopeKey")
);
--> statement-breakpoint
CREATE TABLE "Decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"channel" text NOT NULL,
	"subject" text NOT NULL,
	"slot" text NOT NULL,
	"field" text,
	"kind" text NOT NULL,
	"value" jsonb,
	"other" text,
	"actorKind" text NOT NULL,
	"actorId" text,
	"proposalHash" text,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Decision_channel_check" CHECK ("channel" IN ('assignment', 'veto', 'identity', 'rejection')),
	CONSTRAINT "Decision_kind_check" CHECK ("kind" IN ('set', 'none', 'release', 'veto', 'same', 'distinct', 'reject')),
	CONSTRAINT "Decision_actorKind_check" CHECK ("actorKind" IN ('member', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "Drift" (
	"scopeKind" text,
	"scopeKey" text,
	"version" integer NOT NULL,
	"rules" text NOT NULL,
	"proposalHash" text NOT NULL,
	"inputsHash" text NOT NULL,
	"difference" jsonb NOT NULL,
	"askCount" integer DEFAULT 0 NOT NULL,
	"estimatedCostMicros" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Drift_pkey" PRIMARY KEY("scopeKind","scopeKey")
);
--> statement-breakpoint
CREATE TABLE "EvidenceBinding" (
	"factKind" text,
	"factId" text,
	"basis" text,
	"eventKey" text NOT NULL,
	"scopeKind" text NOT NULL,
	"scopeKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EvidenceBinding_pkey" PRIMARY KEY("factKind","factId","basis"),
	CONSTRAINT "EvidenceBinding_basis_check" CHECK ("basis" IN ('decision', 'baseline', 'proven'))
);
--> statement-breakpoint
CREATE TABLE "FactKey" (
	"key" text,
	"factKind" text,
	"factId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "FactKey_pkey" PRIMARY KEY("key","factKind","factId")
);
--> statement-breakpoint
CREATE TABLE "Pass" (
	"name" text,
	"key" text,
	"cursor" jsonb,
	"claimToken" uuid,
	"claimDeadline" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp DEFAULT now() NOT NULL,
	"waitCause" text,
	"lastError" text,
	"maxAttempts" integer DEFAULT 5 NOT NULL,
	"runId" uuid,
	"doneAt" timestamp,
	"cancelledAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Pass_pkey" PRIMARY KEY("name","key"),
	CONSTRAINT "Pass_waitCause_check" CHECK ("waitCause" IS NULL OR "waitCause" IN ('funding', 'provider_capacity', 'in_flight', 'rate_limit', 'device'))
);
--> statement-breakpoint
CREATE TABLE "KeyRev" (
	"key" text PRIMARY KEY,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RecordKey" (
	"scopeKind" text,
	"scopeKey" text,
	"entity" text,
	"naturalKey" text,
	"entityId" uuid NOT NULL,
	"minted" boolean DEFAULT false NOT NULL,
	"rejectedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RecordKey_pkey" PRIMARY KEY("scopeKind","scopeKey","entity","naturalKey")
);
--> statement-breakpoint
CREATE TABLE "ScopeDep" (
	"scopeKind" text,
	"scopeKey" text,
	"key" text,
	CONSTRAINT "ScopeDep_pkey" PRIMARY KEY("scopeKind","scopeKey","key")
);
--> statement-breakpoint
CREATE TABLE "ScopeDirty" (
	"scopeKind" text,
	"scopeKey" text,
	"lane" text NOT NULL,
	"seq" bigint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"claimedSeq" bigint,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"claimToken" uuid,
	"claimDeadline" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp DEFAULT now() NOT NULL,
	"waitCause" text,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ScopeDirty_pkey" PRIMARY KEY("scopeKind","scopeKey"),
	CONSTRAINT "ScopeDirty_lane_check" CHECK ("lane" IN ('money', 'catalog')),
	CONSTRAINT "ScopeDirty_waitCause_check" CHECK ("waitCause" IS NULL OR "waitCause" IN ('funding', 'provider_capacity', 'in_flight', 'rate_limit', 'device'))
);
--> statement-breakpoint
CREATE TABLE "ScopeState" (
	"scopeKind" text,
	"scopeKey" text,
	"version" integer NOT NULL,
	"rules" text NOT NULL,
	"gaps" jsonb DEFAULT '[]' NOT NULL,
	"inputs" jsonb DEFAULT '[]' NOT NULL,
	"stage" text NOT NULL,
	"nextActor" text,
	"firstGap" text,
	"inputsHash" text,
	"durationMs" integer,
	"errorClass" text,
	"error" text,
	"reconciledAt" timestamp,
	"inputsChangedAt" timestamp,
	CONSTRAINT "ScopeState_pkey" PRIMARY KEY("scopeKind","scopeKey"),
	CONSTRAINT "ScopeState_stage_check" CHECK ("stage" IN ('ended', 'stuck', 'working', 'needs_you', 'waiting', 'done'))
);
--> statement-breakpoint
CREATE INDEX "Answer_feature_idx" ON "Answer" ("feature","createdAt");--> statement-breakpoint
CREATE INDEX "Ask_claim_idx" ON "Ask" ("state","availableAt");--> statement-breakpoint
CREATE INDEX "Ask_sent_deadline_idx" ON "Ask" ("claimDeadline") WHERE "state" = 'sent';--> statement-breakpoint
CREATE INDEX "AskScope_scope_idx" ON "AskScope" ("scopeKind","scopeKey");--> statement-breakpoint
CREATE INDEX "AskScope_run_idx" ON "AskScope" ("runId");--> statement-breakpoint
CREATE INDEX "Decision_slot_idx" ON "Decision" ("subject","channel","slot","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "Decision_other_idx" ON "Decision" ("other");--> statement-breakpoint
CREATE INDEX "EvidenceBinding_event_idx" ON "EvidenceBinding" ("eventKey");--> statement-breakpoint
CREATE INDEX "EvidenceBinding_scope_idx" ON "EvidenceBinding" ("scopeKind","scopeKey");--> statement-breakpoint
CREATE INDEX "FactKey_fact_idx" ON "FactKey" ("factKind","factId");--> statement-breakpoint
CREATE INDEX "Pass_claim_idx" ON "Pass" ("availableAt") WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL;--> statement-breakpoint
CREATE INDEX "RecordKey_entity_idx" ON "RecordKey" ("entity","entityId");--> statement-breakpoint
CREATE INDEX "ScopeDep_key_idx" ON "ScopeDep" ("key");--> statement-breakpoint
CREATE INDEX "ScopeDirty_claim_idx" ON "ScopeDirty" ("lane","scopeKind","availableAt","seq");--> statement-breakpoint
CREATE INDEX "ScopeState_stage_idx" ON "ScopeState" ("stage","nextActor");--> statement-breakpoint
CREATE INDEX "ScopeState_rules_idx" ON "ScopeState" ("scopeKind","rules");--> statement-breakpoint
ALTER TABLE "AskScope" ADD CONSTRAINT "AskScope_askId_Ask_id_fk" FOREIGN KEY ("askId") REFERENCES "Ask"("id") ON DELETE CASCADE;