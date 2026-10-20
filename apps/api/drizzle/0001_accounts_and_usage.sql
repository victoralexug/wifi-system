ALTER TYPE "public"."session_status" ADD VALUE 'exhausted' BEFORE 'revoked';--> statement-breakpoint
ALTER TABLE "access_sessions" ADD COLUMN "bytes_used" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD COLUMN "usage_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "password_hash" text;