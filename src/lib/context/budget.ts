import type { ConversationTurn, FactItem } from "@/lib/providers/types";

/** Shortens text to at most `max` characters, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The text-bearing parts of a generation context, before the total budget is applied. */
export interface ContextSections {
  community: { slug: string; name: string; description: string };
  threadTitle?: string;
  threadBody?: string;
  parentChain: ConversationTurn[];
  currentBody?: string;
  revisionReason?: string;
  threadSummary?: string;
  facts: FactItem[];
  recentComments: ConversationTurn[];
  memory: string[];
  topicHint?: string;
}

const MIN_CHAIN_BODY_CHARS = 80;

function turnChars(turn: ConversationTurn): number {
  return turn.author.length + turn.body.length;
}

function factChars(fact: FactItem): number {
  return fact.publisher.length + fact.title.length + fact.summary.length;
}

/** Characters the sections contribute: every string a model would be shown. */
export function countContextChars(s: ContextSections): number {
  return Object.values(sectionSizes(s)).reduce((sum, size) => sum + size, 0);
}

export function sectionSizes(s: ContextSections): Record<string, number> {
  return {
    community: s.community.name.length + s.community.description.length,
    threadTitle: (s.threadTitle?.length ?? 0) + (s.topicHint?.length ?? 0),
    threadBody: s.threadBody?.length ?? 0,
    parentChain: s.parentChain.reduce((sum, turn) => sum + turnChars(turn), 0),
    currentBody: (s.currentBody?.length ?? 0) + (s.revisionReason?.length ?? 0),
    threadSummary: s.threadSummary?.length ?? 0,
    facts: s.facts.reduce((sum, fact) => sum + factChars(fact), 0),
    recentComments: s.recentComments.reduce((sum, turn) => sum + turnChars(turn), 0),
    memory: s.memory.reduce((sum, item) => sum + item.length, 0),
  };
}

/**
 * Keeps the whole context within `totalChars`. Priority, highest first:
 * community, thread title, thread opening post, parent chain, current body and
 * revision reason, thread summary, facts, recent comments, memory. Over
 * budget, the lowest priority goes first: memory entries from the end, recent
 * comments oldest first, facts last-ranked first, then the thread summary is
 * truncated, then parent-chain bodies are shortened, oldest first, and only
 * then is the opening post truncated. The community,
 * title and current body are never cut, so a context can exceed the budget
 * only when those alone do. Returns new sections; the input is not modified.
 */
export function fitContextSections(
  input: ContextSections,
  totalChars: number,
): { sections: ContextSections; trimmed: string[] } {
  const s: ContextSections = {
    ...input,
    parentChain: input.parentChain.map((turn) => ({ ...turn })),
    facts: [...input.facts],
    recentComments: [...input.recentComments],
    memory: [...input.memory],
  };
  const trimmed = new Set<string>();
  const over = () => countContextChars(s) - totalChars;

  while (over() > 0 && s.memory.length > 0) {
    s.memory.pop();
    trimmed.add("memory");
  }
  while (over() > 0 && s.recentComments.length > 0) {
    s.recentComments.shift();
    trimmed.add("recentComments");
  }
  while (over() > 0 && s.facts.length > 0) {
    s.facts.pop();
    trimmed.add("facts");
  }
  if (over() > 0 && s.threadSummary) {
    const keep = s.threadSummary.length - over();
    s.threadSummary = keep > 0 ? clip(s.threadSummary, keep) : undefined;
    trimmed.add("threadSummary");
  }
  for (const turn of s.parentChain) {
    const excess = over();
    if (excess <= 0) break;
    const target = Math.max(MIN_CHAIN_BODY_CHARS, turn.body.length - excess);
    if (target < turn.body.length) {
      turn.body = clip(turn.body, target);
      trimmed.add("parentChain");
    }
  }
  if (over() > 0 && s.threadBody) {
    const keep = s.threadBody.length - over();
    s.threadBody = keep > 0 ? clip(s.threadBody, keep) : undefined;
    trimmed.add("threadBody");
  }
  return { sections: s, trimmed: [...trimmed] };
}
