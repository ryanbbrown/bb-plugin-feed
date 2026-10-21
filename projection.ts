import type { FeedRow, FeedSection } from "./contract.js";
import type { FeedSummary } from "./store.js";

export const THREAD_STATUSES = [
  "pending",
  "starting",
  "active",
  "stopping",
  "idle",
  "error",
] as const;
export const QUEUED_WORK_STATES = ["none", "waiting", "failed"] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type QueuedWork = (typeof QUEUED_WORK_STATES)[number];

export interface ThreadFacts {
  id: string;
  title: string;
  status: unknown;
  queuedWork: unknown;
  managedChild: boolean;
  inUserManagedSection: boolean;
  latestCompletionSeq: number;
  /** When the agent last answered: the latest turn/completed time, else the thread's creation. */
  answeredAt: number;
  hasActiveNativeTerminal: boolean;
  hasBackgroundWork: boolean;
  hasActiveDescendant: boolean;
  /** Title of a running or starting terminal on a descendant, at any depth. */
  descendantTerminalTitle: string | null;
  hasDescendantBackgroundWork: boolean;
  /** The agent is blocked on the user: an approval, a question, or a form. */
  hasPendingInteraction: boolean;
  /** Set on a nested thread shown because it waits on the user. */
  parentTitle: string | null;
}

export interface RowAnnotations {
  summary: FeedSummary | null;
  latestMessage: string | null;
  markSeq: number | null;
  paused: boolean;
}

export const ONE_LINE_MAX = 240;

export function boundedLine(text: string, max = ONE_LINE_MAX): string {
  const characters = Array.from(text.replace(/\s+/gu, " ").trim());
  return characters.length <= max
    ? characters.join("")
    : `${characters.slice(0, max - 1).join("")}…`;
}

/** R15 fallback: the first sentence of the agent's latest message. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return boundedLine(/^.*?[.!?](?=\s|$)/u.exec(flat)?.[0] ?? flat);
}

/** R15: the line for the latest result, the fallback after a failed call, or null while summarizing. */
function summaryLine(
  latestSeq: number,
  annotations: RowAnnotations,
): { oneLine: string | null; summarizing: boolean } {
  const { summary, latestMessage } = annotations;
  if (latestSeq === 0) return { oneLine: null, summarizing: false };
  if (summary !== null && summary.resultSeq >= latestSeq) {
    return { oneLine: summary.oneLine, summarizing: false };
  }
  if (summary !== null && summary.failedSeq >= latestSeq) {
    return {
      oneLine: latestMessage === null ? null : firstSentence(latestMessage),
      summarizing: false,
    };
  }
  return { oneLine: null, summarizing: true };
}

function parseStatus(value: unknown): ThreadStatus {
  if (
    typeof value === "string" &&
    (THREAD_STATUSES as readonly string[]).includes(value)
  ) {
    return value as ThreadStatus;
  }
  throw new Error(`Unsupported BB thread status: ${String(value)}`);
}

function parseQueuedWork(value: unknown): QueuedWork {
  if (
    typeof value === "string" &&
    (QUEUED_WORK_STATES as readonly string[]).includes(value)
  ) {
    return value as QueuedWork;
  }
  throw new Error(`Unsupported BB queued-work state: ${String(value)}`);
}

function capitalized(status: ThreadStatus): string {
  return status[0]!.toUpperCase() + status.slice(1);
}

const SECTION_ORDER: readonly FeedSection[] = [
  "needs_response",
  "in_progress",
  "paused",
];

type Placement = Pick<FeedRow, "section" | "state" | "statusLabel">;

function place(facts: ThreadFacts, markSeq: number | null): Placement {
  const status = parseStatus(facts.status);
  const queuedWork = parseQueuedWork(facts.queuedWork);
  if (facts.hasPendingInteraction) {
    return {
      section: "needs_response",
      state: "needs_response",
      statusLabel: "Waiting for you",
    };
  }
  if (status === "error") {
    return { section: "needs_response", state: "error", statusLabel: "Failed" };
  }
  if (queuedWork === "failed") {
    return {
      section: "needs_response",
      state: "queued_failed",
      statusLabel: "Queued work failed",
    };
  }
  if (queuedWork === "waiting") {
    return { section: "in_progress", state: "waiting", statusLabel: "Waiting" };
  }
  if (status !== "idle") {
    return {
      section: "in_progress",
      state: "running",
      statusLabel: capitalized(status),
    };
  }
  if (
    facts.hasActiveNativeTerminal ||
    facts.hasBackgroundWork ||
    facts.hasActiveDescendant
  ) {
    return { section: "in_progress", state: "running", statusLabel: "Active" };
  }
  if (facts.descendantTerminalTitle !== null) {
    return {
      section: "in_progress",
      state: "running",
      statusLabel: `Waiting: ${boundedLine(facts.descendantTerminalTitle, 40)}`,
    };
  }
  if (facts.hasDescendantBackgroundWork) {
    return {
      section: "in_progress",
      state: "running",
      statusLabel: "Background work",
    };
  }
  if (!facts.managedChild) {
    return {
      section: "needs_response",
      state: "needs_response",
      statusLabel: "Idle",
    };
  }
  if (markSeq !== null && markSeq >= facts.latestCompletionSeq) {
    return {
      section: "needs_response",
      state: "needs_response",
      statusLabel: "Idle",
    };
  }
  return {
    section: "in_progress",
    state: "with_manager",
    statusLabel: "With manager",
  };
}

export function projectThread(
  facts: ThreadFacts,
  annotations: RowAnnotations,
): FeedRow {
  const placement = place(facts, annotations.markSeq);
  return {
    id: facts.id,
    title: facts.title,
    // A thread that waits on the user leaves Paused.
    section:
      annotations.paused && !facts.hasPendingInteraction
        ? "paused"
        : placement.section,
    state: placement.state,
    // A paused row shows the live BB status; "With manager" is not one.
    statusLabel:
      annotations.paused && placement.state === "with_manager"
        ? "Idle"
        : placement.statusLabel,
    ...summaryLine(facts.latestCompletionSeq, annotations),
    latestMessage: annotations.latestMessage,
    starred: facts.inUserManagedSection,
    managedChild: facts.managedChild,
    paused: annotations.paused,
    parentTitle: facts.parentTitle,
    latestCompletionSeq: facts.latestCompletionSeq,
    answeredAt: facts.answeredAt,
  };
}

function compareRows(left: FeedRow, right: FeedRow): number {
  if (left.answeredAt !== right.answeredAt) {
    return left.section === "needs_response"
      ? left.answeredAt - right.answeredAt
      : right.answeredAt - left.answeredAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function projectFeed(
  facts: readonly ThreadFacts[],
  annotationsFor: (threadId: string) => RowAnnotations,
): FeedRow[] {
  const rows = facts.map((thread) =>
    projectThread(thread, annotationsFor(thread.id)),
  );
  return rows.sort((left, right) =>
    left.section === right.section
      ? compareRows(left, right)
      : SECTION_ORDER.indexOf(left.section) -
        SECTION_ORDER.indexOf(right.section),
  );
}
