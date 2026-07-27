PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_courses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`description` text NOT NULL,
	`notes` text,
	`sales_copy` text NOT NULL,
	`instructor_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`status` text NOT NULL,
	`cover_image_url` text,
	`price` integer DEFAULT 0 NOT NULL,
	`ppp_enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`instructor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_courses`("id", "title", "slug", "description", "notes", "sales_copy", "instructor_id", "category_id", "status", "cover_image_url", "price", "ppp_enabled", "created_at", "updated_at") SELECT "id", "title", "slug", "description", "notes", "sales_copy", "instructor_id", "category_id", "status", "cover_image_url", "price", "ppp_enabled", "created_at", "updated_at" FROM `courses`;--> statement-breakpoint
DROP TABLE `courses`;--> statement-breakpoint
ALTER TABLE `__new_courses` RENAME TO `courses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `courses_slug_unique` ON `courses` (`slug`);