CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_reset_tokens_customer_idx" ON "password_reset_tokens" USING btree ("customer_id");--> statement-breakpoint
-- Emails were optional and stored as typed. Lowercase them, and where two accounts share one,
-- keep it on the oldest account only (the others can add a new email from their account page).
UPDATE "customers" SET "email" = nullif(lower(trim("email")), '');--> statement-breakpoint
UPDATE "customers" c SET "email" = NULL
WHERE "email" IS NOT NULL AND EXISTS (
	SELECT 1 FROM "customers" o
	WHERE o."email" = c."email" AND (o."created_at", o."id") < (c."created_at", c."id")
);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_unique" UNIQUE("email");