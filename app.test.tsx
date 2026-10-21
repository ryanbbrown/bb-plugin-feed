// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { FeedRow as QueueRow, rpcContract } from "./contract.js";

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const app = await loadPluginApp(() => import("./app.js"));
const action = app.threadPanelActions[0]!;

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: "child-1",
    title: "Review child result",
    section: "needs_response",
    state: "needs_response",
    statusLabel: "Idle",
    oneLine: "Needs your response",
    summarizing: false,
    latestMessage: null,
    starred: false,
    managedChild: true,
    paused: false,
    parentTitle: null,
    latestCompletionSeq: 7,
    answeredAt: 1_767_355_445_000,
    ...overrides,
  };
}

function snapshot(rows: QueueRow[] = [row()]) {
  return {
    managerThreadId: "manager-1",
    sectionNames: { userManaged: "User managed", children: "Children" },
    rows,
  };
}

type QueueRenderOptions = Omit<
  RenderSlotOptions<typeof rpcContract>,
  "rpc"
> & {
  rpc?: Partial<PluginRpcTestHandlers<typeof rpcContract>>;
};

function renderQueue(options: QueueRenderOptions = {}) {
  const { rpc, ...rest } = options;
  const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
    canOpen: () => ({ canOpen: true }),
    queueSnapshot: () => snapshot(),
    clearManager: () => ({ cleared: true }),
    setPaused: ({ threadId, paused }) => ({ threadId, paused }),
    detach: () => ({ detached: true }),
    moveSection: () => ({ sectionId: "section-1" }),
    archiveThread: () => ({ archived: true }),
    sendReply: () => ({ accepted: true }),
    ...rpc,
  };
  return renderSlot<PluginThreadPanelProps, typeof rpcContract>(
    action,
    { threadId: "manager-1", params: null },
    {
      settings: { managerThreadId: "manager-1" },
      ...rest,
      rpc: handlers,
    },
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastError.mockReset();
  toastSuccess.mockReset();
  window.localStorage.clear();
});

describe("registration guards", () => {
  it("registers one padded Feed thread action", () => {
    expect(app.threadPanelActions).toHaveLength(1);
    expect(action).toMatchObject({
      id: "feed",
      title: "Feed",
      layout: "padded",
    });
  });

  it("opens only after the cheap backend guard authorizes the manager", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { canOpen: true } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const openPanel = vi.fn(() => true);
    await action.run!({ threadId: "manager-1", openPanel });
    expect(openPanel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/plugins/feed/rpc/canOpen",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ surfaceThreadId: "manager-1" }),
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, result: { canOpen: false } }),
      })),
    );
    await action.run!({ threadId: "other-thread", openPanel });
    expect(openPanel).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("silently declines an unconfigured action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, result: { canOpen: false } }),
      })),
    );
    const openPanel = vi.fn(() => true);

    await action.run!({ threadId: "any-thread", openPanel });

    expect(openPanel).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a bounded authorization failure without opening", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          ok: false,
          error: { message: "x".repeat(300) },
        }),
      })),
    );
    const openPanel = vi.fn(() => true);
    await action.run!({ threadId: "manager-1", openPanel });

    expect(openPanel).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledOnce();
    expect(String(toastError.mock.calls[0]![0]).endsWith("…")).toBe(true);
    expect(String(toastError.mock.calls[0]![0]).length).toBeLessThan(280);
  });

  it("renders no queue content when panel props do not match live settings", () => {
    const slot = renderSlot(
      action,
      { threadId: "other-thread", params: null },
      {
        settings: { managerThreadId: "manager-1" },
        rpc: { queueSnapshot: () => snapshot() },
      },
    );
    expect(slot.container.childElementCount).toBe(0);
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("uses the trimmed manager setting for the panel guard", async () => {
    const slot = renderSlot(
      action,
      { threadId: "manager-1", params: null },
      {
        settings: { managerThreadId: "  manager-1  " },
        rpc: { queueSnapshot: () => snapshot() },
      },
    );
    expect(await slot.findByText("Review child result")).toBeTruthy();
  });
});

const EXPAND_FIRST_ROW = /^Expand Review child result:/;

describe("queue panel", () => {
  const clearDescription =
    "Clear the manager's model context. Rows are not changed.";

  it("places Clear context beside the first heading and shows success or failure", async () => {
    const clearManager = vi.fn(async () => ({ cleared: true as const }));
    const slot = renderQueue({ rpc: { clearManager } });
    const heading = await slot.findByRole("heading", {
      name: "Needs your response",
    });
    const button = slot.getByRole("button", { name: clearDescription });
    expect(button.textContent).toBe("Clear context");
    expect(button.getAttribute("title")).toBe(clearDescription);
    expect(button.getAttribute("aria-label")).toBe(clearDescription);
    expect(button.parentElement).toBe(heading.parentElement);
    expect(button.parentElement?.classList.contains("flex")).toBe(true);
    expect(button.classList.contains("ml-auto")).toBe(true);

    fireEvent.click(button);
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Manager context cleared."),
    );
    expect(clearManager).toHaveBeenCalledWith({ surfaceThreadId: "manager-1" });
    clearManager.mockRejectedValueOnce(new Error("Manager busy"));
    fireEvent.click(slot.getByRole("button", { name: clearDescription }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not clear manager context: Manager busy",
      ),
    );
  });

  it("renders all sections, deterministic states, and Markdown summaries", async () => {
    const rows = [
      row(),
      row({
        id: "child-2",
        title: "Building plugin",
        section: "in_progress",
        state: "running",
        statusLabel: "Active",
        oneLine: "Implements backend",
        latestMessage: "Implements **backend**",
      }),
      row({
        id: "child-3",
        title: "Finished review",
        section: "paused",
        state: "needs_response",
        oneLine: "All checks pass",
        latestMessage: "All checks pass",
      }),
    ];
    const slot = renderQueue({ rpc: { queueSnapshot: () => snapshot(rows) } });

    await slot.findByRole("heading", { name: "Needs your response" });
    expect(slot.getByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Paused" })).toBeTruthy();
    expect(slot.getByText("Needs your response", { selector: "p" })).toBeTruthy();
    expect(slot.getByText("Implements **backend**")).toBeTruthy();
    expect(slot.getByText("Active")).toBeTruthy();
  });

  it("contains Markdown tables in normal and error summaries", async () => {
    const normalTable =
      "| Result | Reference |\n| --- | --- |\n| Ready | https://example.com/a/long/breakable/reference |";
    const errorTable =
      "| Failure | Identifier |\n| --- | --- |\n| Build | failure-identifier-with-breakable-segments |";
    const slot = renderQueue({
      rpc: {
        queueSnapshot: () =>
          snapshot([
            row({
              oneLine: normalTable,
              latestMessage: normalTable,
            }),
            row({
              id: "child-error",
              title: "Failed child",
              state: "error",
              oneLine: "Provider failed",
              latestMessage: errorTable,
            }),
          ]),
      },
    });

    const markdownSummaries = await slot.findAllByTestId("bb-markdown");
    expect(markdownSummaries.map((summary) => summary.textContent)).toEqual([
      normalTable,
      errorTable,
    ]);
    for (const summary of markdownSummaries) {
      expect(summary.className.split(" ")).toEqual(
        expect.arrayContaining(["min-w-0", "max-w-full", "overflow-x-hidden"]),
      );
    }
  });
  it("opens, validates, and sends an exact multiline reply by keyboard", async () => {
    const sendReply = vi.fn(async () => ({ accepted: true as const }));
    const queueSnapshot = vi.fn(() => snapshot());
    const slot = renderQueue({ rpc: { queueSnapshot, sendReply } });
    fireEvent.click(await slot.findByRole("button", { name: EXPAND_FIRST_ROW }));
    const replyButton = await slot.findByRole("button", {
      name: "Reply to Review child result",
    });
    expect(replyButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(replyButton);

    const input = await slot.findByRole("textbox", {
      name: "Reply to Review child result",
    });
    expect(replyButton.getAttribute("aria-expanded")).toBe("true");
    expect(replyButton.getAttribute("aria-controls")).toBe(
      input.closest("form")?.id,
    );
    expect(document.activeElement).toBe(input);
    expect(slot.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.change(input, { target: { value: " \n\t " } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(sendReply).not.toHaveBeenCalled();
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "Enter a reply.",
    );

    const text = "  First line\nSecond line  \n";
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendReply).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(sendReply).toHaveBeenCalledWith({
        surfaceThreadId: "manager-1",
        threadId: "child-1",
        text: `[Re: "Needs your response"]\n\n${text}`,
      });
    });
    await waitFor(() => {
      expect(
        slot.queryByRole("textbox", { name: "Reply to Review child result" }),
      ).toBeNull();
    });
    expect(replyButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(replyButton);
    expect(queueSnapshot).toHaveBeenCalledTimes(2);

    fireEvent.click(replyButton);
    expect(
      (
        (await slot.findByRole("textbox", {
          name: "Reply to Review child result",
        })) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("keeps a failed reply draft and prevents duplicate submits", async () => {
    let rejectSend!: (cause: Error) => void;
    const pending = new Promise<{ accepted: true }>((_resolve, reject) => {
      rejectSend = reject;
    });
    const sendReply = vi.fn(() => pending);
    const slot = renderQueue({ rpc: { sendReply } });
    fireEvent.click(await slot.findByRole("button", { name: EXPAND_FIRST_ROW }));
    const replyButton = await slot.findByRole("button", {
      name: "Reply to Review child result",
    });
    fireEvent.click(replyButton);
    const input = (await slot.findByRole("textbox", {
      name: "Reply to Review child result",
    })) as HTMLTextAreaElement;
    const exactDraft = "  Retry this\nwithout trimming  ";
    fireEvent.change(input, { target: { value: exactDraft } });
    const form = input.closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(sendReply).toHaveBeenCalledOnce();
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(input.disabled).toBe(true);
    expect(slot.getByRole("button", { name: "Sending…" })).toHaveProperty(
      "disabled",
      true,
    );

    await act(async () => {
      rejectSend(new Error("x".repeat(300)));
      await pending.catch(() => undefined);
    });

    const error = await slot.findByRole("alert");
    expect(error.textContent?.endsWith("…")).toBe(true);
    expect(error.textContent?.length).toBe(240);
    expect(input.value).toBe(exactDraft);
    expect(input.disabled).toBe(false);
    expect(replyButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows neutral review state without New result or a stale summary", async () => {
    const slot = renderQueue({
      rpc: {
        queueSnapshot: () =>
          snapshot([
            row({
              section: "in_progress",
              state: "with_manager",
              oneLine: "Awaiting manager review",
              latestMessage: null,
            }),
          ]),
      },
    });

    expect(await slot.findByText("Awaiting manager review")).toBeTruthy();
    expect(slot.queryByText("New result")).toBeNull();
    expect(slot.queryByText("Earlier reviewed result")).toBeNull();
  });

  it("keeps failure text visible with the earlier summary as context", async () => {
    const failed = row({
      state: "queued_failed",
      statusLabel: "Idle",
      oneLine: "Queued work failed",
      latestMessage: "Earlier successful result",
    });
    const slot = renderQueue({
      rpc: { queueSnapshot: () => snapshot([failed]) },
    });

    expect(await slot.findByText("Queued work failed")).toBeTruthy();
    expect(slot.getByText("Earlier successful result")).toBeTruthy();
  });

  it("navigates from the title with no split action", async () => {
    const slot = renderQueue({ rpc: { queueSnapshot: () => snapshot() } });
    const title = await slot.findByRole("button", {
      name: "Review child result",
    });

    expect(title.className).toContain("cursor-pointer");
    expect(title.className).toContain("prompt-mention-pill");
    expect(title.className).toContain("text-xs");
    expect(title.textContent).not.toContain("↗");
    fireEvent.click(title);
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "child-1" },
    ]);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
  });
  it("toggles from the two-line row without taking over the title", async () => {
    const archiveThread = vi.fn(() => ({ archived: true as const }));
    const slot = renderQueue({
      rpc: {
        archiveThread,
        queueSnapshot: () =>
          snapshot([
            row(),
            row({
              id: "child-2",
              title: "Running child",
              section: "in_progress",
              state: "running",
              statusLabel: "Active",
            }),
          ]),
      },
    });
    const disclosure = await slot.findByRole("button", {
      name: EXPAND_FIRST_ROW,
    });
    const content = document.getElementById(
      disclosure.getAttribute("aria-controls")!,
    )!;
    const oneLine = slot.getAllByText("Needs your response", { selector: "p" })[0]!;

    expect(oneLine.className).toContain("line-clamp-2");
    expect(oneLine.className).toContain("text-xs");
    expect(slot.queryByText("Idle")).toBeNull();
    expect(slot.getByText("Active")).toBeTruthy();
    expect(disclosure.className).toContain("flex-1");
    expect(oneLine.closest("button")).toBeNull();
    expect(disclosure.className).toContain("hover:bg-state-hover");
    expect(disclosure.className).toContain("focus-visible:ring-2");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(content.hidden).toBe(true);

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(content.hidden).toBe(false);
    fireEvent.click(disclosure);
    expect(content.hidden).toBe(true);
    fireEvent.click(disclosure);

    fireEvent.click(slot.getByRole("button", { name: "Review child result" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "child-1" },
    ]);
    expect(content.hidden).toBe(false);
    fireEvent.click(
      slot.getByRole("button", { name: "Archive Review child result" }),
    );
    await waitFor(() => expect(archiveThread).toHaveBeenCalledOnce());
  });

  it("persists an expanded row across an app reload", async () => {
    const stableRow = row({
      state: "with_manager",
      oneLine: "Stable detail",
      latestMessage: null,
    });
    const first = renderQueue({
      rpc: { queueSnapshot: () => snapshot([stableRow]) },
    });
    const expand = await first.findByRole("button", {
      name: /^Expand Review child result:/,
    });
    const content = document.getElementById(
      expand.getAttribute("aria-controls")!,
    )!;

    fireEvent.click(expand);
    expect(content.hidden).toBe(false);
    expect(
      (first.getByRole("button", {
        name: "Archive Review child result",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
    first.lifecycle.unmount();

    const reloaded = renderQueue({
      rpc: {
        queueSnapshot: () =>
          snapshot([
            stableRow,
            row({
              id: "child-2",
              title: "Other child",
              state: "with_manager",
              oneLine: "Stable detail",
              latestMessage: null,
            }),
          ]),
      },
    });
    const persisted = await reloaded.findByRole("button", {
      name: /^Collapse Review child result:/,
    });
    expect(
      document.getElementById(persisted.getAttribute("aria-controls")!)?.hidden,
    ).toBe(false);
    expect(
      reloaded.getByRole("button", { name: /^Expand Other child:/ }),
    ).toBeTruthy();
  });

  it("keeps a row expanded through an unchanged snapshot refresh", async () => {
    const stableRow = row({
      state: "with_manager",
      oneLine: "Stable detail",
      latestMessage: null,
    });
    const slot = renderQueue({
      rpc: { queueSnapshot: () => snapshot([stableRow]) },
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Expand Review child result:/ }),
    );

    await slot.behavior.emitRealtime("feed-invalidated", {
      threadId: "child-1",
      reason: "thread.idle",
    });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

    const persisted = slot.getByRole("button", {
      name: /^Collapse Review child result:/,
    });
    expect(
      document.getElementById(persisted.getAttribute("aria-controls")!)?.hidden,
    ).toBe(false);
  });

  it.each(["one-line summary", "card result"] as const)(
    "collapses an expanded row when its %s changes",
    async (changedField) => {
      let changed = false;
      const currentRow = () =>
        changedField === "one-line summary"
          ? row({
              oneLine: changed ? "Updated summary" : "Earlier summary",
              latestMessage: changed ? "Updated card" : "Earlier card",
              latestCompletionSeq: 7,
            })
          : row({
              oneLine: "Same summary",
              latestMessage: "Same card",
              latestCompletionSeq: changed ? 9 : 7,
            });
      const slot = renderQueue({
        rpc: { queueSnapshot: () => snapshot([currentRow()]) },
      });
      fireEvent.click(
        await slot.findByRole("button", { name: /^Expand Review child result:/ }),
      );
      changed = true;

      await slot.behavior.emitRealtime("feed-invalidated", {
        threadId: "child-1",
        reason: "card-written",
      });
      await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

      const collapsed = slot.getByRole("button", {
        name: /^Expand Review child result:/,
      });
      expect(
        document.getElementById(collapsed.getAttribute("aria-controls")!)?.hidden,
      ).toBe(true);
    },
  );

  it("refetches after archive failure instead of restoring a stale snapshot", async () => {
    let rejectArchive!: (error: Error) => void;
    const archive = new Promise<never>((_resolve, reject) => {
      rejectArchive = reject;
    });
    let snapshotCalls = 0;
    const slot = renderQueue({
      rpc: {
        queueSnapshot: () => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) return snapshot();
          if (snapshotCalls === 2) {
            return snapshot([row({ title: "Newer authoritative title" })]);
          }
          return snapshot([row({ title: "Final authoritative title" })]);
        },
        archiveThread: () => archive,
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: EXPAND_FIRST_ROW }));
    const archiveButton = await slot.findByRole("button", {
      name: "Archive Review child result",
    });
    fireEvent.click(archiveButton);
    expect(slot.queryByText("Review child result")).toBeNull();
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({
      method: "archiveThread",
      input: {
        surfaceThreadId: "manager-1",
        threadId: "child-1",
      },
    });

    await slot.behavior.emitRealtime("feed-invalidated", {
      threadId: "child-1",
      reason: "thread.idle",
    });
    await slot.findByText("Newer authoritative title");
    rejectArchive(new Error("x".repeat(300)));

    await slot.findByText("Final authoritative title");
    expect(slot.queryByText("Review child result")).toBeNull();
    expect(snapshotCalls).toBe(3);
    const alert = slot.getByRole("alert");
    expect(alert.textContent?.endsWith("…")).toBe(true);
    expect(alert.textContent!.length).toBeLessThan(250);
  });

  it("shows accessible loading, empty, activation-disabled, and error states", async () => {
    const loading = renderQueue({
      rpc: { queueSnapshot: () => new Promise<never>(() => undefined) },
    });
    expect(loading.getByRole("status").getAttribute("aria-busy")).toBe("true");
    loading.lifecycle.unmount();

    const empty = renderQueue({ rpc: { queueSnapshot: () => snapshot([]) } });
    const emptyMessage = await empty.findByText(/Feed is empty/i);
    const clearButton = empty.getByRole("button", { name: clearDescription });
    expect(clearButton.textContent).toBe("Clear context");
    expect(clearButton.getAttribute("title")).toBe(clearDescription);
    expect(clearButton.parentElement).toBe(emptyMessage.parentElement);
    expect(clearButton.parentElement?.classList.contains("flex-wrap")).toBe(true);
    expect(clearButton.classList.contains("ml-auto")).toBe(true);
    expect(empty.queryByRole("heading")).toBeNull();
    empty.lifecycle.unmount();

    const failed = renderQueue({
      rpc: { queueSnapshot: () => Promise.reject(new Error("Server unavailable")) },
    });
    expect((await failed.findByRole("alert")).textContent).toContain(
      "Server unavailable",
    );
  });

  it("keeps hidden or cross-project snapshot rows and refreshes a rename every 15 seconds", async () => {
    vi.useFakeTimers();
    let title = "Hidden cross-project child";
    const slot = renderQueue({
      rpc: {
        queueSnapshot: () => snapshot([row({ title })]),
      },
      sidebarThreads: { threads: [] },
    });
    await act(async () => Promise.resolve());
    expect(slot.getByText("Hidden cross-project child")).toBeTruthy();

    title = "Renamed hidden child";
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(slot.getByText("Renamed hidden child")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  it("coalesces a burst of invalidations into one trailing refresh", async () => {
    vi.useFakeTimers();
    const slot = renderQueue({
      rpc: { queueSnapshot: () => snapshot() },
    });
    await act(async () => Promise.resolve());
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    await slot.behavior.emitRealtime("feed-invalidated", { reason: "one" });
    await slot.behavior.emitRealtime("feed-invalidated", { reason: "two" });
    await slot.behavior.emitRealtime("feed-invalidated", { reason: "three" });
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  it("refetches after realtime invalidation and reconnect", async () => {
    const slot = renderQueue({
      rpc: { queueSnapshot: () => snapshot() },
      realtimeConnectionState: "connected",
    });
    await slot.findByText("Review child result");
    await slot.behavior.emitRealtime("feed-invalidated", {
      threadId: "child-1",
      reason: "thread.idle",
    });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(3));
  });
});
