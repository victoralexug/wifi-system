CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"code" text NOT NULL,
	"order_id" uuid,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_code_unique" UNIQUE("code"),
	CONSTRAINT "vouchers_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vouchers_plan_unused_idx" ON "vouchers" USING btree ("plan_id","order_id");