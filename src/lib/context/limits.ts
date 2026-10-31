export const CONTEXT_LIMITS = {
  community: 300,
  threadBody: 1000,
  summary: 1200,
  parentChainItems: 4,
  parentChainItemChars: 500,
  recentComments: 5,
  recentCommentChars: 300,
  facts: 4,
  factSummaryChars: 400,
  memoryItems: 8,
  memoryTotalChars: 800,
  memoryItemChars: 200,
  totalChars: 6000,
} as const;

export type ContextLimits = { [K in keyof typeof CONTEXT_LIMITS]: number };
