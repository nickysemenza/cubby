CREATE TABLE `products` (
	`upc` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`manufacturer` text,
	`brand` text,
	`category` text,
	`description` text,
	`price_dollars` real,
	`image_key` text,
	`source` text NOT NULL,
	`source_data` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_products_name` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `idx_products_manufacturer` ON `products` (`manufacturer`);