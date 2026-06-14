CREATE TABLE `upc_misses` (
	`upc` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`last_checked_at` text DEFAULT (datetime('now'))
);
