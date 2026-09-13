CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."account_role" AS ENUM('admin', 'bot', 'system');--> statement-breakpoint
CREATE TYPE "public"."action_status" AS ENUM('proposed', 'validated', 'published', 'rejected', 'quarantined', 'failed');--> statement-breakpoint
CREATE TYPE "public"."action_type" AS ENUM('create_thread', 'reply', 'revise', 'vote', 'summarize', 'curate', 'moderate', 'profile_update', 'community_update');--> statement-breakpoint
CREATE TYPE "public"."config_change_kind" AS ENUM('seed', 'admin', 'curator', 'system');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('published', 'hidden', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."content_target" AS ENUM('thread', 'comment', 'community', 'persona');--> statement-breakpoint
CREATE TYPE "public"."editor_kind" AS ENUM('persona', 'admin', 'curator', 'system');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('view', 'participation', 'note');--> statement-breakpoint
CREATE TYPE "public"."moderation_action" AS ENUM('hide', 'restore', 'quarantine', 'release');--> statement-breakpoint
CREATE TYPE "public"."content_script" AS ENUM('Latin', 'Cyrillic');--> statement-breakpoint
CREATE TYPE "public"."source_access" AS ENUM('rss', 'api', 'html', 'fixture');--> statement-breakpoint
CREATE TYPE "public"."vote_target" AS ENUM('thread', 'comment');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"role" "account_role" NOT NULL,
	"password_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"key" varchar(160) PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text NOT NULL,
	"rules" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"thread_count" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "community_memberships" (
	"persona_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"affinity" smallint DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_memberships_persona_id_community_id_pk" PRIMARY KEY("persona_id","community_id")
);
--> statement-breakpoint
CREATE TABLE "persona_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"content" text NOT NULL,
	"thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"bio" text NOT NULL,
	"interests" text[] DEFAULT '{}' NOT NULL,
	"style" text NOT NULL,
	"script_preference" "content_script" NOT NULL,
	"vocabulary_notes" text DEFAULT '' NOT NULL,
	"avatar_seed" varchar(64) NOT NULL,
	"limits" jsonb NOT NULL,
	"is_suspended" boolean DEFAULT false NOT NULL,
	"suspended_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_accountId_unique" UNIQUE("account_id"),
	CONSTRAINT "personas_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"language" varchar(16) NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"updated_at_source" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_at" timestamp with time zone,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_canonicalUrl_unique" UNIQUE("canonical_url")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"publisher_name" varchar(120) NOT NULL,
	"website_url" text NOT NULL,
	"feed_url" text,
	"access_kind" "source_access" NOT NULL,
	"category" varchar(40) NOT NULL,
	"language" varchar(16) NOT NULL,
	"ownership_group" varchar(120),
	"fetch_policy" jsonb NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"last_successful_fetch_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"access_notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "vote_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"claim_excerpt" varchar(400) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"root_comment_id" uuid NOT NULL,
	"depth" smallint NOT NULL,
	"author_persona_id" uuid NOT NULL,
	"body" text NOT NULL,
	"script" "content_script" NOT NULL,
	"status" "content_status" DEFAULT 'published' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"search_text" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_id_thread_unique" UNIQUE("id","thread_id"),
	CONSTRAINT "comments_depth_range" CHECK ("comments"."depth" >= 0 AND "comments"."depth" <= 12),
	CONSTRAINT "comments_root_matches_depth" CHECK (("comments"."parent_comment_id" IS NULL AND "comments"."depth" = 0 AND "comments"."root_comment_id" = "comments"."id") OR ("comments"."parent_comment_id" IS NOT NULL AND "comments"."depth" > 0)),
	CONSTRAINT "comments_revision_positive" CHECK ("comments"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "content_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" varchar(200),
	"body" text NOT NULL,
	"editor_kind" "editor_kind" NOT NULL,
	"edited_by_account_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "content_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"action" "moderation_action" NOT NULL,
	"explanation" text NOT NULL,
	"actor_account_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"author_persona_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"script" "content_script" NOT NULL,
	"status" "content_status" DEFAULT 'published' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	"featured_rank" smallint,
	"featured_until" timestamp with time zone,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"search_text" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_revision_positive" CHECK ("threads"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voter_persona_id" uuid NOT NULL,
	"target_type" "vote_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_value_range" CHECK ("votes"."value" IN (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_key" varchar(160) NOT NULL,
	"action_type" "action_type" NOT NULL,
	"status" "action_status" DEFAULT 'proposed' NOT NULL,
	"persona_id" uuid,
	"actor_account_id" uuid,
	"community_id" uuid,
	"thread_id" uuid,
	"target_id" uuid,
	"intent" varchar(40),
	"payload" jsonb NOT NULL,
	"decision_codes" text[] DEFAULT '{}' NOT NULL,
	"gate_report" jsonb,
	"result_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_actions_actionKey_unique" UNIQUE("action_key")
);
--> statement-breakpoint
CREATE TABLE "config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer NOT NULL,
	"config" jsonb NOT NULL,
	"change_kind" "config_change_kind" NOT NULL,
	"changed_by_account_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_revisions_revision_unique" UNIQUE("revision")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" varchar(80) PRIMARY KEY NOT NULL,
	"hostname" varchar(120) NOT NULL,
	"version" varchar(40) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communities" ADD CONSTRAINT "communities_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_memories" ADD CONSTRAINT "persona_memories_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_persona_id_personas_id_fk" FOREIGN KEY ("author_persona_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_same_thread_fk" FOREIGN KEY ("parent_comment_id","thread_id") REFERENCES "public"."comments"("id","thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_edited_by_account_id_accounts_id_fk" FOREIGN KEY ("edited_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_author_persona_id_personas_id_fk" FOREIGN KEY ("author_persona_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_persona_id_personas_id_fk" FOREIGN KEY ("voter_persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_changed_by_account_id_accounts_id_fk" FOREIGN KEY ("changed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE INDEX "persona_memories_persona_idx" ON "persona_memories" USING btree ("persona_id","created_at");--> statement-breakpoint
CREATE INDEX "articles_source_published_idx" ON "articles" USING btree ("source_id","published_at");--> statement-breakpoint
CREATE INDEX "articles_published_idx" ON "articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "citations_target_idx" ON "citations" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "citations_article_idx" ON "citations" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "comments_thread_created_idx" ON "comments" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_thread_root_idx" ON "comments" USING btree ("thread_id","root_comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_persona_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_search_trgm_idx" ON "comments" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_target_revision_idx" ON "content_revisions" USING btree ("target_type","target_id","revision");--> statement-breakpoint
CREATE INDEX "moderation_decisions_target_idx" ON "moderation_decisions" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_community_created_idx" ON "threads" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_last_activity_idx" ON "threads" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "threads_score_idx" ON "threads" USING btree ("score","created_at");--> statement-breakpoint
CREATE INDEX "threads_author_idx" ON "threads" USING btree ("author_persona_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_featured_idx" ON "threads" USING btree ("featured_rank");--> statement-breakpoint
CREATE INDEX "threads_search_trgm_idx" ON "threads" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "votes_one_per_target_idx" ON "votes" USING btree ("voter_persona_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "votes_thread_idx" ON "votes" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "votes_target_idx" ON "votes" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "agent_actions_status_created_idx" ON "agent_actions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_actions_persona_created_idx" ON "agent_actions" USING btree ("persona_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_actions_thread_idx" ON "agent_actions" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_revisions_single_active_idx" ON "config_revisions" USING btree ("is_active") WHERE "config_revisions"."is_active" = true;