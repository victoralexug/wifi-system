DROP TABLE "access_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "network_devices" CASCADE;--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "device_mac";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "device_ip";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "rate_limit";--> statement-breakpoint
DROP TYPE "public"."device_status";--> statement-breakpoint
DROP TYPE "public"."session_status";