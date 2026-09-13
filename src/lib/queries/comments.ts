import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import {
  articles,
  citations,
  comments,
  communities,
  moderationDecisions,
  personas,
  sources,
  threads,
} from "@/lib/db/schema";

export interface CommentCitation {
  claimExcerpt: string;
  title: string;
  canonicalUrl: string;
  publisher: string;
  isFixture: boolean;
}

export interface CommentNode {
  id: string;
  threadId: string;
  parentCommentId: string | null;
  rootCommentId: string;
  depth: number;
  body: string;
  script: "Latin" | "Cyrillic";
  status: "published" | "hidden" | "quarantined";
  score: number;
  replyCount: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  author: { slug: string; displayName: string; avatarSeed: string };
  hiddenExplanation: string | null;
  citations: CommentCitation[];
  children: CommentNode[];
  /** True when descendants exist that were not loaded inline (depth or size bound). */
  hasMoreBelow: boolean;
}

export interface CommentTree {
  roots: CommentNode[];
  /** Total comments loaded into the tree (any depth). */
  loaded: number;
  hasMoreRoots: boolean;
}

const nodeColumns = {
  id: comments.id,
  threadId: comments.threadId,
  parentCommentId: comments.parentCommentId,
  rootCommentId: comments.rootCommentId,
  depth: comments.depth,
  body: comments.body,
  script: comments.script,
  status: comments.status,
  score: comments.score,
  replyCount: comments.replyCount,
  revision: comments.revision,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
  authorSlug: personas.slug,
  authorName: personas.displayName,
  authorSeed: personas.avatarSeed,
};

function selectNodes(db: DbOrTx) {
  return db
    .select(nodeColumns)
    .from(comments)
    .innerJoin(personas, eq(personas.id, comments.authorPersonaId));
}

type NodeRow = Awaited<ReturnType<typeof selectNodes>>[number];

function toNode(row: NodeRow): CommentNode {
  return {
    id: row.id,
    threadId: row.threadId,
    parentCommentId: row.parentCommentId,
    rootCommentId: row.rootCommentId,
    depth: row.depth,
    body: row.status === "published" ? row.body : "",
    script: row.script,
    status: row.status,
    score: row.score,
    replyCount: row.replyCount,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: { slug: row.authorSlug, displayName: row.authorName, avatarSeed: row.authorSeed },
    hiddenExplanation: null,
    citations: [],
    children: [],
    hasMoreBelow: false,
  };
}

async function decorate(db: DbOrTx, nodes: Map<string, CommentNode>): Promise<void> {
  const ids = [...nodes.keys()];
  if (ids.length === 0) return;
  const hiddenIds = ids.filter((id) => nodes.get(id)?.status === "hidden");
  if (hiddenIds.length > 0) {
    const decisions = await db
      .select({
        targetId: moderationDecisions.targetId,
        explanation: moderationDecisions.explanation,
        createdAt: moderationDecisions.createdAt,
      })
      .from(moderationDecisions)
      .where(
        and(
          eq(moderationDecisions.targetType, "comment"),
          inArray(moderationDecisions.targetId, hiddenIds),
        ),
      )
      .orderBy(desc(moderationDecisions.createdAt));
    for (const decision of decisions) {
      const node = nodes.get(decision.targetId);
      if (node && node.hiddenExplanation === null)
        node.hiddenExplanation = decision.explanation;
    }
  }
  const cites = await db
    .select({
      targetId: citations.targetId,
      claimExcerpt: citations.claimExcerpt,
      title: articles.title,
      canonicalUrl: articles.canonicalUrl,
      publisher: sources.publisherName,
      isFixture: articles.isFixture,
    })
    .from(citations)
    .innerJoin(articles, eq(articles.id, citations.articleId))
    .innerJoin(sources, eq(sources.id, articles.sourceId))
    .where(and(eq(citations.targetType, "comment"), inArray(citations.targetId, ids)));
  for (const cite of cites) {
    nodes.get(cite.targetId)?.citations.push({
      claimExcerpt: cite.claimExcerpt,
      title: cite.title,
      canonicalUrl: cite.canonicalUrl,
      publisher: cite.publisher,
      isFixture: cite.isFixture,
    });
  }
}

function assemble(
  rows: NodeRow[],
  anchorParent: string | null,
  maxInlineDepth: number,
): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const row of rows) nodes.set(row.id, toNode(row));
  const top: CommentNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentCommentId === anchorParent) {
      top.push(node);
      continue;
    }
    const parent = node.parentCommentId ? nodes.get(node.parentCommentId) : undefined;
    if (parent) parent.children.push(node);
  }
  const sortChildren = (list: CommentNode[]) => {
    list.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    for (const child of list) sortChildren(child.children);
  };
  sortChildren(top);
  // Beyond the inline depth, drop children from the payload and mark the node.
  const trim = (list: CommentNode[], relativeDepth: number) => {
    for (const node of list) {
      if (relativeDepth >= maxInlineDepth - 1 && node.children.length > 0) {
        node.hasMoreBelow = true;
        node.children = [];
        continue;
      }
      if (node.replyCount > node.children.length) node.hasMoreBelow = true;
      trim(node.children, relativeDepth + 1);
    }
  };
  trim(top, 0);
  return top;
}

export interface LoadTreeOptions {
  rootsLimit?: number;
  maxNodes?: number;
  maxInlineDepth?: number;
}

/**
 * Loads a page of top-level comments and their descendants, bounded both in
 * count and in visible depth. Branches cut by either bound link to the
 * continuation view instead of disappearing.
 */
export async function loadCommentTree(
  db: DbOrTx,
  threadId: string,
  options: LoadTreeOptions = {},
): Promise<CommentTree> {
  const rootsLimit = options.rootsLimit ?? 30;
  const maxNodes = options.maxNodes ?? 400;
  const maxInlineDepth = options.maxInlineDepth ?? 6;

  const rootRows = await selectNodes(db)
    .where(and(eq(comments.threadId, threadId), eq(comments.depth, 0)))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(rootsLimit + 1);
  const hasMoreRoots = rootRows.length > rootsLimit;
  const roots = rootRows.slice(0, rootsLimit);
  if (roots.length === 0) return { roots: [], loaded: 0, hasMoreRoots };

  const rootIds = roots.map((row) => row.id);
  const descendants = await selectNodes(db)
    .where(
      and(
        eq(comments.threadId, threadId),
        inArray(comments.rootCommentId, rootIds),
        sql`${comments.depth} > 0`,
      ),
    )
    .orderBy(asc(comments.depth), asc(comments.createdAt))
    .limit(maxNodes);

  const rows = [...roots, ...descendants];
  const tree = assemble(rows, null, maxInlineDepth);
  const flat = new Map<string, CommentNode>();
  const walk = (list: CommentNode[]) => {
    for (const node of list) {
      flat.set(node.id, node);
      walk(node.children);
    }
  };
  walk(tree);
  await decorate(db, flat);
  return { roots: tree, loaded: flat.size, hasMoreRoots };
}

/** A single comment with its descendants, for the continuation view. */
export async function loadCommentSubtree(
  db: DbOrTx,
  threadId: string,
  commentId: string,
  options: LoadTreeOptions = {},
): Promise<{ anchor: CommentNode; tree: CommentNode[] } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(commentId)) return null;
  const anchorRows = await selectNodes(db)
    .where(and(eq(comments.id, commentId), eq(comments.threadId, threadId)))
    .limit(1);
  const anchorRow = anchorRows[0];
  if (!anchorRow) return null;
  const descendants = await selectNodes(db)
    .where(
      and(
        eq(comments.threadId, threadId),
        eq(comments.rootCommentId, anchorRow.rootCommentId),
        sql`${comments.depth} > ${anchorRow.depth}`,
      ),
    )
    .orderBy(asc(comments.depth), asc(comments.createdAt))
    .limit(options.maxNodes ?? 400);
  // Keep only rows under the anchor: walk parents within the fetched set.
  const byId = new Map(descendants.map((row) => [row.id, row]));
  const underAnchor = descendants.filter((row) => {
    let current: NodeRow | undefined = row;
    while (current && current.parentCommentId) {
      if (current.parentCommentId === anchorRow.id) return true;
      current = byId.get(current.parentCommentId);
    }
    return false;
  });
  const tree = assemble(underAnchor, anchorRow.id, options.maxInlineDepth ?? 6);
  const anchor = toNode(anchorRow);
  const flat = new Map<string, CommentNode>([[anchor.id, anchor]]);
  const walk = (list: CommentNode[]) => {
    for (const node of list) {
      flat.set(node.id, node);
      walk(node.children);
    }
  };
  walk(tree);
  await decorate(db, flat);
  return { anchor, tree };
}

export interface RecentComment {
  id: string;
  threadId: string;
  threadTitle: string;
  body: string;
  status: "published" | "hidden" | "quarantined";
  score: number;
  createdAt: Date;
  communitySlug: string;
}

export async function listCommentsByAuthor(
  db: DbOrTx,
  personaId: string,
  limit = 10,
): Promise<RecentComment[]> {
  return db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      threadTitle: threads.title,
      body: comments.body,
      status: comments.status,
      score: comments.score,
      createdAt: comments.createdAt,
      communitySlug: communities.slug,
    })
    .from(comments)
    .innerJoin(threads, eq(threads.id, comments.threadId))
    .innerJoin(communities, eq(communities.id, threads.communityId))
    .where(
      and(
        eq(comments.authorPersonaId, personaId),
        eq(comments.status, "published"),
        eq(threads.status, "published"),
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(limit);
}
