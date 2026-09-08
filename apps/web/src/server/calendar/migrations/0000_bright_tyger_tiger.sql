CREATE TABLE `calendar_credentials` (
	`owner` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_credentials_username_unique` ON `calendar_credentials` (`username`);--> statement-breakpoint
CREATE TABLE `calendar_documents` (
	`feed` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`etag` text NOT NULL,
	`generated_at` text NOT NULL,
	`revision` integer NOT NULL,
	`item_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`generated_at` text,
	`origin` text,
	`dirty_reason` text,
	`dirty_sequence` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_pending` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text NOT NULL,
	`origin` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_pending_fingerprint_unique` ON `calendar_pending` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `calendar_resources` (
	`generation` integer NOT NULL,
	`collection` text NOT NULL,
	`filename` text NOT NULL,
	`uid` text NOT NULL,
	`shortcode` text NOT NULL,
	`body` text NOT NULL,
	`etag` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`projection` text NOT NULL,
	PRIMARY KEY(`generation`, `collection`, `filename`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_resource_uid` ON `calendar_resources` (`generation`,`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_resource_entity` ON `calendar_resources` (`generation`,`shortcode`);--> statement-breakpoint
CREATE INDEX `calendar_resource_dates` ON `calendar_resources` (`generation`,`collection`,`start`,`end`);