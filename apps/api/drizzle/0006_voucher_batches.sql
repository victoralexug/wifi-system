CREATE TABLE "voucher_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text,
	"code_count" integer NOT NULL,
	"ready_at" timestamp with time zone,
	"ready_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_batches_period_unique" UNIQUE("period")
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "voucher_stock_target" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_batch_id_voucher_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."voucher_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Codes uploaded before batches existed came from the router, so they were usable from the start.
UPDATE "vouchers" SET "ready_at" = "created_at" WHERE "ready_at" IS NULL;
