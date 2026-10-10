-- No CASCADE: the only foreign key into these tables is RunFactEvidence ->
-- RunEvidence, so dropping the fact table first keeps an unexpected
-- dependency a loud failure instead of a silent cascade.
DROP TABLE "RunFactEvidence";--> statement-breakpoint
DROP TABLE "RunEvidence";--> statement-breakpoint
DROP TABLE "RunOrderCandidate";--> statement-breakpoint
DROP TABLE "ImportHunt";--> statement-breakpoint
DROP TABLE "ResearchRetention";--> statement-breakpoint
DROP TABLE "ResearchSourceExposure";
