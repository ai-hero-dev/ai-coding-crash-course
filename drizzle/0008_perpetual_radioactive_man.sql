CREATE INDEX `enrollments_course_idx` ON `enrollments` (`course_id`);--> statement-breakpoint
CREATE INDEX `lesson_progress_user_lesson_idx` ON `lesson_progress` (`user_id`,`lesson_id`);--> statement-breakpoint
CREATE INDEX `purchases_course_idx` ON `purchases` (`course_id`);