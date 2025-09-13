PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usda_food` (
	`fdc_id` integer PRIMARY KEY NOT NULL,
	`data_type` text NOT NULL,
	`description` text,
	`food_category_id` text,
	`publication_date` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_usda_food`("fdc_id", "data_type", "description", "food_category_id", "publication_date") SELECT "fdc_id", "data_type", "description", "food_category_id", "publication_date" FROM `usda_food`;--> statement-breakpoint
DROP TABLE `usda_food`;--> statement-breakpoint
ALTER TABLE `__new_usda_food` RENAME TO `usda_food`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `food_fdc_id` ON `usda_food` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `usda_food_description_idx` ON `usda_food` (`description`);--> statement-breakpoint
CREATE INDEX `usda_food_data_type_idx` ON `usda_food` (`data_type`);