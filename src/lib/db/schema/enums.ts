import { pgEnum } from "drizzle-orm/pg-core";

export const accountRoleEnum = pgEnum("account_role", ["admin", "bot", "system"]);

export const scriptEnum = pgEnum("content_script", ["Latin", "Cyrillic"]);

/**
 * published: publicly visible.
 * hidden: removed from public view by moderation; the record and its history stay.
 * quarantined: never published; failed a gate and awaits administrator review.
 */
export const contentStatusEnum = pgEnum("content_status", [
  "published",
  "hidden",
  "quarantined",
]);

export const contentTargetEnum = pgEnum("content_target", [
  "thread",
  "comment",
  "community",
  "persona",
]);

export const voteTargetEnum = pgEnum("vote_target", ["thread", "comment"]);

export const editorKindEnum = pgEnum("editor_kind", ["persona", "admin", "curator", "system"]);

export const moderationActionEnum = pgEnum("moderation_action", [
  "hide",
  "restore",
  "quarantine",
  "release",
]);

export const memoryKindEnum = pgEnum("memory_kind", ["view", "participation", "note"]);

export const sourceAccessEnum = pgEnum("source_access", ["rss", "api", "html", "fixture"]);

export const actionTypeEnum = pgEnum("action_type", [
  "create_thread",
  "reply",
  "revise",
  "vote",
  "summarize",
  "curate",
  "moderate",
  "profile_update",
  "community_update",
]);

export const actionStatusEnum = pgEnum("action_status", [
  "proposed",
  "validated",
  "published",
  "rejected",
  "quarantined",
  "failed",
]);

export const configChangeKindEnum = pgEnum("config_change_kind", [
  "seed",
  "admin",
  "curator",
  "system",
]);
