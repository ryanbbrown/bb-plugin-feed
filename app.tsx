import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Markdown,
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { FeedRow, rpcContract } from "./contract.js";

const DISCLOSURE_STORAGE_PREFIX = "feed.row-disclosure.";
const REPLY_DRAFT_STORAGE_PREFIX = "feed.reply-draft.";
const SORT_STORAGE_KEY = "feed.sort-order";
const INVALIDATION_DEBOUNCE_MS = 100;
const REFRESH_INTERVAL_MS = 15_000;
const PLUGIN_ID = "feed";

interface Snapshot {
  managerThreadId: string;
  sectionNames: { userManaged: string; children: string };
  rows: FeedRow[];
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; snapshot: Snapshot }
  | { status: "error"; message: string };

type SortOrder = "newest" | "oldest";

// BB unmounts the panel when the thread is hidden; this module stays loaded, so a remount shows the last snapshot.
const snapshotCache = new Map<string, Snapshot>();

function readSortOrder(): SortOrder {
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY) === "oldest"
      ? "oldest"
      : "newest";
  } catch {
    return "newest";
  }
}

function writeSortOrder(order: SortOrder): void {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, order);
  } catch {
    // Local state remains available when browser storage is unavailable.
  }
}

function sortRows(rows: FeedRow[], order: SortOrder): FeedRow[] {
  const direction = order === "newest" ? -1 : 1;
  return [...rows].sort(
    (left, right) =>
      direction * (left.answeredAt - right.answeredAt) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

function formatRelativeTime(timestamp: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatFullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function rowLineText(row: FeedRow): string {
  if (row.parentTitle !== null) return `Waits for you, under ${row.parentTitle}`;
  if (row.summarizing) return "Summarizing…";
  return row.oneLine ?? "No result yet";
}

function boundedError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.length <= 240 ? message : `${message.slice(0, 239)}…`;
}

async function actionMayOpen(threadId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/rpc/canOpen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surfaceThreadId: threadId }),
    });
    const envelope = (await response.json()) as {
      ok?: boolean;
      result?: { canOpen?: boolean };
      error?: { message?: string };
    };
    if (response.ok && envelope.ok === true) {
      return envelope.result?.canOpen === true;
    }
    const reason = boundedError(
      envelope.error?.message ?? "The authorization request failed.",
    );
    toast.error(`Could not open Feed: ${reason}`);
  } catch (cause) {
    toast.error(`Could not open Feed: ${boundedError(cause)}`);
  }
  return false;
}

function StateBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function useQueueSnapshot(threadId: string, sectionIds: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LoadState>(() => {
    const cached = snapshotCache.get(threadId);
    return cached ? { status: "ready", snapshot: cached } : { status: "loading" };
  });
  const requestSequence = useRef(0);

  useEffect(() => {
    if (state.status === "ready") snapshotCache.set(threadId, state.snapshot);
  }, [state, threadId]);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const snapshot = await rpc.call("queueSnapshot", {
        surfaceThreadId: threadId,
      });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", snapshot });
      }
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setState({ status: "error", message: boundedError(cause) });
      }
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invalidationTimeout = useRef<number | undefined>(undefined);
  const scheduleInvalidationRefresh = useCallback(() => {
    if (invalidationTimeout.current !== undefined) {
      window.clearTimeout(invalidationTimeout.current);
    }
    invalidationTimeout.current = window.setTimeout(() => {
      invalidationTimeout.current = undefined;
      void refresh();
    }, INVALIDATION_DEBOUNCE_MS);
  }, [refresh]);
  useEffect(
    () => () => {
      if (invalidationTimeout.current !== undefined) {
        window.clearTimeout(invalidationTimeout.current);
      }
    },
    [],
  );
  useRealtime("feed-invalidated", scheduleInvalidationRefresh);

  const connection = useRealtimeConnectionState();
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") {
      wasDisconnected.current = true;
      return;
    }
    if (!wasDisconnected.current) return;
    wasDisconnected.current = false;
    void refresh();
  }, [connection, refresh]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;
    const schedule = () => {
      timeout = window.setTimeout(() => {
        void refresh().finally(() => {
          if (!cancelled) schedule();
        });
      }, REFRESH_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [refresh]);

  const sidebar = experimental_useSidebarThreads();
  const sidebarFingerprint = useMemo(
    () =>
      sidebar.threads
        .filter(
          (thread) =>
            thread.parentThreadId === threadId ||
            (thread.parentThreadId === null &&
              thread.sectionId !== null &&
              sectionIds.includes(thread.sectionId)),
        )
        .map(
          (thread) =>
            `${thread.id}\u0000${thread.title ?? ""}\u0000${thread.titleFallback ?? ""}\u0000${thread.sectionId ?? ""}\u0000${thread.isArchived}`,
        )
        .sort()
        .join("\u0001"),
    [sectionIds, sidebar.threads, threadId],
  );
  const priorFingerprint = useRef(sidebarFingerprint);
  useEffect(() => {
    if (priorFingerprint.current === sidebarFingerprint) return;
    priorFingerprint.current = sidebarFingerprint;
    scheduleInvalidationRefresh();
  }, [scheduleInvalidationRefresh, sidebarFingerprint]);

  const supersedeRefresh = useCallback(() => {
    requestSequence.current += 1;
  }, []);

  return { rpc, state, setState, refresh, supersedeRefresh };
}

interface RowDisclosureState {
  expanded: boolean;
  fingerprint: string;
}

function rowContentFingerprint(row: FeedRow): string {
  return JSON.stringify([row.latestCompletionSeq, row.latestMessage]);
}

function disclosureStorageKey(threadId: string): string {
  return `${DISCLOSURE_STORAGE_PREFIX}${threadId}`;
}

function readRowDisclosure(
  threadId: string,
  fingerprint: string,
): RowDisclosureState {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(disclosureStorageKey(threadId)) ?? "null",
    ) as Partial<RowDisclosureState> | null;
    if (
      stored?.fingerprint === fingerprint &&
      typeof stored.expanded === "boolean"
    ) {
      return { expanded: stored.expanded, fingerprint };
    }
  } catch {
    // Local state remains available when browser storage is unavailable.
  }
  return { expanded: false, fingerprint };
}

function writeRowDisclosure(
  threadId: string,
  disclosure: RowDisclosureState,
): void {
  try {
    window.localStorage.setItem(
      disclosureStorageKey(threadId),
      JSON.stringify(disclosure),
    );
  } catch {
    // Local state remains available when browser storage is unavailable.
  }
}

function readReplyDraft(threadId: string): string {
  try {
    return window.localStorage.getItem(`${REPLY_DRAFT_STORAGE_PREFIX}${threadId}`) ?? "";
  } catch {
    return "";
  }
}

function writeReplyDraft(threadId: string, draft: string): void {
  try {
    const key = `${REPLY_DRAFT_STORAGE_PREFIX}${threadId}`;
    if (draft.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, draft);
  } catch {
    // Local state remains available when browser storage is unavailable.
  }
}

const ROW_BUTTON_CLASS =
  "inline-flex h-6 cursor-pointer items-center rounded-md border border-border bg-background px-1.5 text-xs font-medium hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const ACTION_BUTTON_CLASS =
  "min-h-7 cursor-pointer rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function PersonIcon() {
  return (
    <svg
      aria-hidden="true"
      className="-ml-px size-3.5 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        d="M17 8.5C17 5.73858 14.7614 3.5 12 3.5C9.23858 3.5 7 5.73858 7 8.5C7 11.2614 9.23858 13.5 12 13.5C14.7614 13.5 17 11.2614 17 8.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path
        d="M19 20.5C19 16.634 15.866 13.5 12 13.5C8.13401 13.5 5 16.634 5 20.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`size-3.5 shrink-0 ${filled ? "text-yellow-500" : "text-muted-foreground"}`}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9L12 3.5z" />
    </svg>
  );
}

function FeedRowView({
  row,
  sectionNames,
  now,
  mutation,
  onNavigate,
  onPause,
  onArchive,
  onDetach,
  onMoveSection,
  onReply,
}: {
  row: FeedRow;
  sectionNames: Snapshot["sectionNames"];
  now: number;
  mutation: string | null;
  onNavigate: () => void;
  onPause: () => void;
  onArchive: () => void;
  onDetach: () => void;
  onMoveSection: () => void;
  onReply: (text: string) => Promise<void>;
}) {
  const [replyDraft, setReplyDraft] = useState(() => readReplyDraft(row.id));
  const [replyOpen, setReplyOpen] = useState(() => replyDraft.length > 0);
  // A form restored from a saved draft does not take focus when the panel mounts.
  const restoredReplyOpen = useRef(replyOpen);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySending, setReplySending] = useState(false);
  const replySendingRef = useRef(false);
  const restoreReplyFocus = useRef(false);
  const replyButtonRef = useRef<HTMLButtonElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const replyId = useId();
  const replyFormId = `${replyId}-form`;
  const replyInputId = `${replyId}-input`;
  const replyHintId = `${replyId}-hint`;
  const replyErrorId = `${replyId}-error`;
  const busy = mutation !== null || replySending;
  // A nested row only links to its thread: the server acts on Feed threads only.
  const nested = row.parentTitle !== null;
  useEffect(() => {
    if (replyOpen && !restoredReplyOpen.current) replyInputRef.current?.focus();
    restoredReplyOpen.current = false;
  }, [replyOpen]);
  useEffect(() => {
    if (!replyOpen && !replySending && restoreReplyFocus.current) {
      restoreReplyFocus.current = false;
      replyButtonRef.current?.focus();
    }
  }, [replyOpen, replySending]);
  const openReply = () => {
    setReplyError(null);
    setReplyOpen(true);
    if (replyOpen) replyInputRef.current?.focus();
  };
  const cancelReply = () => {
    setReplyError(null);
    setReplyDraft("");
    writeReplyDraft(row.id, "");
    setReplyOpen(false);
    replyButtonRef.current?.focus();
  };
  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (replySendingRef.current) return;
    if (replyDraft.trim().length === 0) {
      setReplyError("Enter a reply.");
      replyInputRef.current?.focus();
      return;
    }
    const text = replyDraft;
    replySendingRef.current = true;
    setReplySending(true);
    setReplyError(null);
    try {
      await onReply(text);
      restoreReplyFocus.current = true;
      setReplyDraft("");
      writeReplyDraft(row.id, "");
      setReplyOpen(false);
      collapseDisclosure();
    } catch (cause) {
      setReplyError(boundedError(cause));
    } finally {
      replySendingRef.current = false;
      setReplySending(false);
    }
  };
  const handleReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const fingerprint = rowContentFingerprint(row);
  const [disclosure, setDisclosure] = useState<RowDisclosureState>(() =>
    readRowDisclosure(row.id, fingerprint),
  );
  const expanded =
    disclosure.fingerprint === fingerprint && disclosure.expanded;
  useEffect(() => {
    writeRowDisclosure(row.id, { expanded, fingerprint });
  }, [expanded, fingerprint, row.id]);
  const toggleDisclosure = () => {
    const next = { expanded: !expanded, fingerprint };
    setDisclosure(next);
    writeRowDisclosure(row.id, next);
  };
  const collapseDisclosure = () => {
    const next = { expanded: false, fingerprint };
    setDisclosure(next);
    writeRowDisclosure(row.id, next);
  };
  const contentId = `feed-row-content-${row.id}`;
  const time = row.answeredAt;
  // A managed child is detached into the user managed section; a root moves to the other section.
  const starAction = `Move to ${
    row.starred && !row.managedChild
      ? sectionNames.children
      : sectionNames.userManaged
  }`;

  return (
    <li className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className="prompt-mention-pill inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-full border pl-1 pr-1.5 text-start text-xs font-normal no-underline hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={row.title}
          onClick={onNavigate}
        >
          <PersonIcon />
          <span className="min-w-0 truncate">{row.title}</span>
        </button>
        {nested ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={row.managedChild ? onDetach : onMoveSection}
          title={starAction}
          aria-label={`${starAction}: ${row.title}`}
          aria-pressed={row.starred}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <StarIcon filled={row.starred} />
        </button>
        )}
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${row.title}: ${rowLineText(row).replace(/[.…]$/u, "")}. ${row.statusLabel}`}
          className="flex min-h-7 min-w-7 flex-1 cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-start text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={toggleDisclosure}
        >
          <time
            className="text-[11px] text-muted-foreground"
            dateTime={new Date(time).toISOString()}
            title={formatFullTime(time)}
          >
            {formatRelativeTime(time, now)}
          </time>
          <svg
            aria-hidden="true"
            className="ml-auto size-3.5 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              d={expanded ? "M6 9L12 15L18 9" : "M9 6L15 12L9 18"}
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.75"
            />
          </svg>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {row.statusLabel === "Idle" ? null : (
            <span
              className={`text-xs ${
                row.state === "error" || row.state === "queued_failed"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {row.statusLabel}
            </span>
          )}
          {nested ? null : (
        <button
            type="button"
            disabled={busy}
            onClick={onArchive}
            className={`${ROW_BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
            aria-label={`Archive ${row.title}`}
          >
            Archive
          </button>
        )}
        </div>
      </div>
      <div className="mt-1.5 flex min-w-0 items-end gap-2">
        {row.summarizing ? (
          <p
            role="status"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <svg
              aria-hidden="true"
              className="size-3 shrink-0 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="M12 3a9 9 0 1 0 9 9"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
            Summarizing…
          </p>
        ) : (
          <p className="line-clamp-2 min-w-0 flex-1 break-words text-xs text-muted-foreground">
            {rowLineText(row)}
          </p>
        )}
        {nested ? null : (
        <div className="flex shrink-0 gap-2">
          <button
            ref={replyButtonRef}
            type="button"
            aria-controls={replyFormId}
            aria-expanded={replyOpen}
            aria-label={`Reply to ${row.title}`}
            disabled={busy}
            onClick={openReply}
            className={`${ROW_BUTTON_CLASS} text-foreground`}
          >
            Reply
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onPause}
            aria-label={`${row.paused ? "Unpause" : "Pause"} ${row.title}`}
            className={`${ROW_BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
          >
            {row.paused ? "Unpause" : "Pause"}
          </button>
        </div>
        )}
      </div>
      <div
        id={contentId}
        hidden={!expanded}
        className="mt-2.5 border-t border-border/60 pt-2.5"
      >
        {row.latestMessage === null ? (
          <p className="break-words text-sm text-muted-foreground">
            No agent message yet
          </p>
        ) : (
          <Markdown
            content={row.latestMessage}
            className="min-w-0 max-w-full overflow-x-hidden break-words text-sm text-muted-foreground"
          />
        )}
      </div>
      {replyOpen ? (
        <form
          id={replyFormId}
          aria-busy={replySending}
          className="mt-2 space-y-2 rounded-md border border-border bg-background p-2.5"
          onSubmit={(event) => void submitReply(event)}
        >
          <label
            htmlFor={replyInputId}
            className="block text-xs font-medium text-foreground"
          >
            Reply to {row.title}
          </label>
          <textarea
            ref={replyInputRef}
            id={replyInputId}
            name="reply"
            rows={3}
            autoComplete="off"
            aria-invalid={replyError !== null}
            aria-describedby={
              replyError === null
                ? replyHintId
                : `${replyHintId} ${replyErrorId}`
            }
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={replySending}
            value={replyDraft}
            onChange={(event) => {
              setReplyDraft(event.target.value);
              writeReplyDraft(row.id, event.target.value);
              setReplyError(null);
            }}
            onKeyDown={handleReplyKeyDown}
            className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="Write a reply"
          />
          <p id={replyHintId} className="text-[11px] text-muted-foreground">
            Press ⌘ or Ctrl+Enter to send. Enter adds a new line.
          </p>
          {replyError === null ? null : (
            <p
              id={replyErrorId}
              role="alert"
              className="break-words text-xs text-destructive"
            >
              {replyError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={replySending}
              onClick={cancelReply}
              className="min-h-7 cursor-pointer rounded-md px-2 text-xs text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={replySending}
              className="min-h-7 cursor-pointer rounded-md border border-border bg-foreground px-2.5 text-xs font-medium text-background hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {replySending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

const SECTIONS = [
  { id: "needs_response", title: "Needs your response" },
  { id: "in_progress", title: "In progress" },
  { id: "paused", title: "Paused" },
] as const;

function FeedPanelContent({
  threadId,
  sectionIds,
}: {
  threadId: string;
  sectionIds: readonly string[];
}) {
  const navigate = useBbNavigate();
  const { rpc, state, setState, refresh, supersedeRefresh } =
    useQueueSnapshot(threadId, sectionIds);
  const [mutation, setMutation] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>(readSortOrder);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const changeSortOrder = (order: SortOrder) => {
    setSortOrder(order);
    writeSortOrder(order);
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await rpc.call("clearManager", { surfaceThreadId: threadId });
      toast.success("Manager context cleared.");
    } catch (cause) {
      toast.error(`Could not clear manager context: ${boundedError(cause)}`);
    } finally {
      setClearing(false);
    }
  };

  if (state.status === "loading") {
    return (
      <StateBox>
        <span role="status" aria-busy="true">
          Loading Feed…
        </span>
      </StateBox>
    );
  }
  if (state.status === "error") {
    return (
      <StateBox>
        <span role="alert">Could not load the Feed: {state.message}</span>
      </StateBox>
    );
  }

  const { snapshot } = state;
  const updateRows = (update: (rows: FeedRow[]) => FeedRow[]) =>
    setState((current) =>
      current.status !== "ready"
        ? current
        : {
            status: "ready",
            snapshot: { ...current.snapshot, rows: update(current.snapshot.rows) },
          },
    );
  const replaceRow = (next: FeedRow) =>
    updateRows((rows) =>
      rows.map((candidate) => (candidate.id === next.id ? next : candidate)),
    );
  // Row actions change the row at once; a failed call puts the row back and shows the error.
  const mutate = async (
    row: FeedRow,
    next: FeedRow,
    action: () => Promise<unknown>,
  ) => {
    if (mutation !== null) return;
    supersedeRefresh();
    setMutation(row.id);
    setMutationError(null);
    replaceRow(next);
    try {
      await action();
    } catch (cause) {
      supersedeRefresh();
      replaceRow(row);
      setMutationError(boundedError(cause));
    } finally {
      setMutation(null);
    }
    void refresh();
  };
  const setPaused = (row: FeedRow) => {
    const paused = !row.paused;
    return mutate(
      row,
      {
        ...row,
        paused,
        section: paused
          ? "paused"
          : row.state === "needs_response" ||
              row.state === "error" ||
              row.state === "queued_failed"
            ? "needs_response"
            : "in_progress",
        statusLabel:
          row.state === "with_manager"
            ? paused
              ? "Idle"
              : "With manager"
            : row.statusLabel,
      },
      () =>
        rpc.call("setPaused", {
          surfaceThreadId: threadId,
          threadId: row.id,
          paused,
        }),
    );
  };
  // A detached child becomes a starred root, and a root has no "With manager" state.
  const detach = (row: FeedRow) =>
    mutate(
      row,
      {
        ...row,
        starred: true,
        managedChild: false,
        ...(row.state === "with_manager"
          ? {
              section: row.paused ? "paused" : "needs_response",
              state: "needs_response",
              statusLabel: "Idle",
            }
          : {}),
      },
      () => rpc.call("detach", { surfaceThreadId: threadId, threadId: row.id }),
    );
  const moveSection = (row: FeedRow) =>
    mutate(row, { ...row, starred: !row.starred }, () =>
      rpc.call("moveSection", { surfaceThreadId: threadId, threadId: row.id }),
    );
  // R21a: the reply quotes the line the user saw.
  const sendReply = async (row: FeedRow, text: string) => {
    await rpc.call("sendReply", {
      surfaceThreadId: threadId,
      threadId: row.id,
      text: row.summarizing || row.oneLine === null
        ? text
        : `[Re: ${JSON.stringify(row.oneLine)}]\n\n${text}`,
    });
    // The row moves to In progress at once; the refresh confirms it in the background.
    supersedeRefresh();
    setState((current) =>
      current.status !== "ready"
        ? current
        : {
            status: "ready",
            snapshot: {
              ...current.snapshot,
              rows: current.snapshot.rows.map((candidate) =>
                candidate.id !== row.id || candidate.paused
                  ? candidate
                  : {
                      ...candidate,
                      section: "in_progress",
                      state: "running",
                      statusLabel: "Active",
                    },
              ),
            },
          },
    );
    void refresh();
  };
  const archive = async (row: FeedRow) => {
    if (mutation !== null) return;
    supersedeRefresh();
    setMutation(row.id);
    setMutationError(null);
    updateRows((rows) => rows.filter((candidate) => candidate.id !== row.id));
    try {
      await rpc.call("archiveThread", {
        surfaceThreadId: threadId,
        threadId: row.id,
      });
    } catch (cause) {
      supersedeRefresh();
      updateRows((rows) =>
        rows.some((candidate) => candidate.id === row.id) ? rows : [...rows, row],
      );
      setMutationError(boundedError(cause));
      void refresh();
    } finally {
      setMutation(null);
    }
  };

  const clearDescription =
    "Clear the manager's model context. Rows are not changed.";
  const clearButton = (
    <button
      type="button"
      disabled={clearing}
      onClick={() => void clear()}
      title={clearDescription}
      aria-label={clearDescription}
      className={`ml-auto shrink-0 ${ACTION_BUTTON_CLASS}`}
    >
      Clear context
    </button>
  );
  const sortButton = (
    <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
      <button
        type="button"
        onClick={() =>
          changeSortOrder(sortOrder === "newest" ? "oldest" : "newest")
        }
        className="min-h-7 cursor-pointer rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {sortOrder === "newest" ? "Sort: newest first" : "Sort: oldest first"}
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {mutationError === null ? null : (
        <p role="alert" className="break-words text-sm text-destructive">
          {mutationError}
        </p>
      )}
      {snapshot.rows.length === 0 ? (
        <StateBox>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="min-w-0 basis-48 flex-1">
              The Feed is empty. The manager's children and root threads in the configured sections appear here.
            </span>
            {clearButton}
          </div>
        </StateBox>
      ) : SECTIONS.map((section) => {
        const rows = sortRows(
          snapshot.rows.filter((row) => row.section === section.id),
          sortOrder,
        );
        const headingId = `feed-${section.id}`;
        return (
          <section key={section.id} aria-labelledby={headingId}>
            <div className="flex items-center gap-2">
              <h2
                id={headingId}
                className="text-sm font-semibold text-foreground"
              >
                {section.title}
              </h2>
              {section.id === "needs_response" ? clearButton : null}
            </div>
            {rows.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No threads.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {rows.map((row) => (
                  <FeedRowView
                    key={row.id}
                    row={row}
                    sectionNames={snapshot.sectionNames}
                    now={now}
                    mutation={mutation}
                    onNavigate={() => navigate.toThread(row.id)}
                    onPause={() => void setPaused(row)}
                    onArchive={() => void archive(row)}
                    onDetach={() => void detach(row)}
                    onMoveSection={() => void moveSection(row)}
                    onReply={(text) => sendReply(row, text)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {sortButton}
    </div>
  );
}

function settingText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function FeedPanel({ threadId }: PluginThreadPanelProps) {
  const { values, isLoading } = useSettings();
  const managerThreadId = settingText(values?.managerThreadId);
  const userManagedSectionId = settingText(values?.userManagedSectionId);
  const childrenSectionId = settingText(values?.childrenSectionId);
  const sectionIds = useMemo(
    () => [userManagedSectionId, childrenSectionId].filter(Boolean),
    [childrenSectionId, userManagedSectionId],
  );
  if (isLoading || managerThreadId !== threadId) return null;
  return <FeedPanelContent threadId={threadId} sectionIds={sectionIds} />;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "feed",
    title: "Feed",
    icon: "ListTodo",
    layout: "padded",
    component: FeedPanel,
    run: async ({ threadId, openPanel }) => {
      if (await actionMayOpen(threadId)) {
        openPanel({ title: "Feed" });
      }
    },
  });
});
