CREATE TABLE `calendar_identities` (
	`shortcode` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`filename` text NOT NULL,
	`uid` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_identities_uid_unique` ON `calendar_identities` (`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_identity_path` ON `calendar_identities` (`entity`,`filename`);--> statement-breakpoint
CREATE TABLE `calendar_uncertain_writes` (
	`entity` text NOT NULL,
	`collection` text NOT NULL,
	`filename` text NOT NULL,
	`uid` text NOT NULL,
	`shortcode` text,
	`started_at` text NOT NULL,
	PRIMARY KEY(`entity`, `filename`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_uncertain_writes_uid_unique` ON `calendar_uncertain_writes` (`uid`);--> statement-breakpoint
DROP TABLE `calendar_pending`;--> statement-breakpoint
ALTER TABLE `calendar_meta` ADD `refresh_failed_at` text;
--> statement-breakpoint
DELETE FROM calendar_resources;
--> statement-breakpoint
DELETE FROM calendar_documents;
--> statement-breakpoint
DELETE FROM calendar_credentials;
--> statement-breakpoint
DELETE FROM calendar_meta;
