CREATE TABLE IF NOT EXISTS `response_chunks` (
	`key` text NOT NULL,
	`seq` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`key`, `seq`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `responses` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`expires_at` integer,
	`claim_token` text,
	`lease_expires_at` integer
);
--> statement-breakpoint
DROP INDEX IF EXISTS `responses_expires_at_idx`;
