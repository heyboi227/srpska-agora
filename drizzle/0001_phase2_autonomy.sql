CREATE TYPE "public"."budget_stage" AS ENUM('normal', 'reduced', 'minimal', 'paused');--> statement-breakpoint
CREATE TYPE "public"."scheduler_action_kind" AS ENUM('thread', 'reply', 'revision', 'summary', 'vote');--> statement-breakpoint
CREATE TYPE "public"."scheduler_decision_outcome" AS ENUM('queued', 'published', 'quarantined', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scheduler_run_state" AS ENUM('planned', 'idle', 'paused', 'backpressure', 'skipped_interval', 'error');--> statement-breakpoint
CREATE TYPE "public"."budget_period_kind" AS ENUM('day', 'month');--> statement-breakpoint
CREATE TYPE "public"."cost_reservation_status" AS ENUM('open', 'settled', 'released', 'ambiguous');--> statement-breakpoint
CREATE TYPE "public"."provider_purpose" AS ENUM('generation', 'repair', 'validation', 'search');--> statement-breakpoint
CREATE TYPE "public"."provider_request_origin" AS ENUM('scheduler', 'admin', 'system', 'eval', 'simulation');--> statement-breakpoint
CREATE TYPE "public"."provider_request_status" AS ENUM('reserved', 'succeeded', 'failed', 'ambiguous', 'rejected');--> statement-breakpoint
CREATE TABLE "thread_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"script" "content_script" NOT NULL,
	"covers_comment_count" integer NOT NULL,
	"last_comment_at" timestamp with time zone,
	"source_article_ids" uuid[] DEFAULT '{}' NOT NULL,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "scheduler_action_kind" NOT NULL,
	"action_key" varchar(160) NOT NULL,
	"persona_id" uuid,
	"community_id" uuid,
	"thread_id" uuid,
	"target_id" uuid,
	"intent" varchar(40),
	"score" double precision NOT NULL,
	"probability" double precision,
	"breakdown" jsonb NOT NULL,
	"outcome" "scheduler_decision_outcome" DEFAULT 'queued' NOT NULL,
	"outcome_code" varchar(60),
	"job_id" varchar(64),
	"action_id" uuid,
	"not_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "scheduler_decisions_actionKey_unique" UNIQUE("action_key")
);
--> statement-breakpoint
CREATE TABLE "scheduler_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tick_at" timestamp with time zone NOT NULL,
	"state" "scheduler_run_state" NOT NULL,
	"budget_stage" "budget_stage" NOT NULL,
	"planned_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"details" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "budget_period_kind" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"limit_micros" bigint NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_request_id" uuid NOT NULL,
	"day_period_id" uuid NOT NULL,
	"month_period_id" uuid NOT NULL,
	"amount_micros" bigint NOT NULL,
	"actual_micros" bigint,
	"status" "cost_reservation_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "cost_reservations_providerRequestId_unique" UNIQUE("provider_request_id")
);
--> statement-breakpoint
CREATE TABLE "provider_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_key" varchar(160),
	"purpose" "provider_purpose" NOT NULL,
	"origin" "provider_request_origin" NOT NULL,
	"provider" varchar(40) NOT NULL,
	"model" varchar(80) NOT NULL,
	"status" "provider_request_status" NOT NULL,
	"reject_reason" varchar(60),
	"estimated_input_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"estimated_micros" bigint NOT NULL,
	"actual_micros" bigint,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "thread_summaries" ADD CONSTRAINT "thread_summaries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_run_id_scheduler_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scheduler_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD CONSTRAINT "cost_reservations_provider_request_id_provider_requests_id_fk" FOREIGN KEY ("provider_request_id") REFERENCES "public"."provider_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD CONSTRAINT "cost_reservations_day_period_id_budget_periods_id_fk" FOREIGN KEY ("day_period_id") REFERENCES "public"."budget_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD CONSTRAINT "cost_reservations_month_period_id_budget_periods_id_fk" FOREIGN KEY ("month_period_id") REFERENCES "public"."budget_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_summaries_thread_revision_idx" ON "thread_summaries" USING btree ("thread_id","revision");--> statement-breakpoint
CREATE INDEX "scheduler_decisions_created_at_idx" ON "scheduler_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scheduler_decisions_outcome_idx" ON "scheduler_decisions" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE INDEX "scheduler_decisions_persona_idx" ON "scheduler_decisions" USING btree ("persona_id","created_at");--> statement-breakpoint
CREATE INDEX "scheduler_decisions_thread_idx" ON "scheduler_decisions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "scheduler_runs_tick_at_idx" ON "scheduler_runs" USING btree ("tick_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_periods_kind_start_uq" ON "budget_periods" USING btree ("kind","period_start");--> statement-breakpoint
CREATE INDEX "cost_reservations_status_idx" ON "cost_reservations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "provider_requests_created_at_idx" ON "provider_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "provider_requests_action_key_idx" ON "provider_requests" USING btree ("action_key");--> statement-breakpoint
CREATE INDEX "provider_requests_status_idx" ON "provider_requests" USING btree ("status","created_at");