CREATE TABLE IF NOT EXISTS `cooldowns` (
	`bucket` text PRIMARY KEY NOT NULL,
	`until_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credit_epochs` (
	`bucket` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credit_refusals` (
	`bucket` text PRIMARY KEY NOT NULL,
	`until_ms` integer NOT NULL,
	`reason` text NOT NULL,
	`probe_window` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `permits` (
	`token` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`deadline` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `starts` (
	`bucket` text NOT NULL,
	`started` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `starts_time` ON `starts` (`started`);
