CREATE TABLE "router_reports" (
	"kind" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "used_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "session_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "session_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "online_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "first_used_at" timestamp with time zone;--> statement-breakpoint
-- Codes already sold expire their plan's duration after they were given out.
UPDATE "vouchers" SET "expires_at" = "vouchers"."assigned_at" + "plans"."duration_minutes" * interval '1 minute' FROM "plans" WHERE "plans"."id" = "vouchers"."plan_id" AND "vouchers"."assigned_at" IS NOT NULL;
