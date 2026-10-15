import { describe, expect, it, vi } from "vitest";
import type {
  BbPluginApi,
  PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

// Summary calls read the Codex login; a missing one makes every call fail without network access.
process.env.CODEX_HOME = "/nonexistent/feed-test-codex-home";
import { SCHEMA_STATEMENTS as INITIAL_SCHEMA_STATEMENTS } from "./store.js";

type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];
type ThreadEventRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
type TerminalSession = Awaited<
  ReturnType<BbPluginApi["sdk"]["terminals"]["list"]>
>["sessions"][number];
type RunningThread = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["listRunning"]>
>[number];
type SdkSubscription = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];
type ThreadChangedSubscription = Extract<
  SdkSubscription,
  { event: "thread:changed" }
>;

function isThreadChangedSubscription(
  subscription: SdkSubscription,
): subscription is ThreadChangedSubscription {
  return subscription.event === "thread:changed";
}

function listEntry(
  id: string,
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  const response = makeThreadResponse({
    id,
    title: `Title ${id}`,
    parentThreadId: "manager-1",
  });
  const {
    activeBackgroundAgentCount: _activeBackgroundAgentCount,
    canSpawnChild: _canSpawnChild,
    queuedMessageCount: _queuedMessageCount,
    ...thread
  } = response;
  return {
    ...thread,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    queuedWork: "none",
    pinSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    environmentIsWorktree: null,
    environmentProviderId: null,
    environmentPath: null,
    ...overrides,
  };
}

function completion(threadId: string, seq: number): ThreadEventRow {
  return {
    id: `event-${seq}`,
    scope: { kind: "turn", turnId: `turn-${seq}` },
    threadId,
    seq,
    type: "turn/completed",
    data: {
      providerThreadId: "provider-thread",
      status: "completed",
    },
    createdAt: seq,
  };
}

function runningThread(id: string): RunningThread {
  return { id, hostId: "host-1" };
}

function terminalSession(
  id: string,
  threadId: string,
  status: TerminalSession["status"],
): TerminalSession {
  return {
    id,
    title: `Terminal ${id}`,
    threadId,
    environmentId: null,
    hostId: "host-1",
    initialCwd: "/work",
    status,
    exitCode: status === "exited" ? 0 : null,
    closeReason: status === "exited" ? "process-exit" : null,
    rows: 24,
    cols: 80,
    createdAt: 100,
    updatedAt: 200,
    lastUserInputAt: null,
  };
}

function terminalChanges(): {
  emit(threadId: string): void;
  subscribe: BbPluginApi["sdk"]["subscribe"];
} {
  let callback: ThreadChangedSubscription["callback"] | null = null;
  return {
    emit(threadId) {
      callback?.({
        type: "changed",
        entity: "thread",
        id: threadId,
        changes: ["terminals-changed"],
      });
    },
    subscribe(subscription) {
      if (isThreadChangedSubscription(subscription)) {
        callback = subscription.callback;
      }
      return () => {
        if (isThreadChangedSubscription(subscription)) callback = null;
      };
    },
  };
}

function toolResult(output: unknown): Record<string, unknown> {
  return JSON.parse(String(output)) as Record<string, unknown>;
}

function agentContext(threadId: string): PluginAgentConfigurationContext {
  return {
    thread: {
      id: threadId,
      title: "Manager",
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: "project-1",
      kind: "standard",
      name: "Project",
      gitRemoteUrl: null,
    },
    environment: {
      id: "environment-1",
      name: "Environment",
      path: "/work",
      workspaceProvisionType: "unmanaged",
      branchName: "main",
    },
    host: { id: "host-1", name: "Host" },
    provider: {
      id: "pi",
      model: "test-model",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: null },
    pluginMetadata: {},
  };
}

const FULL_SETTINGS = {
  managerThreadId: "manager-1",
  userManagedSectionId: "section-user",
  childrenSectionId: "section-children",
  summarizerModel: "test-model",
};

async function configuredHost(options: {
  settings?: Record<string, string>;
  managerThreadId?: string;
  get?: BbPluginApi["sdk"]["threads"]["get"];
  list?: (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => Promise<ThreadListEntry[]>;
  running?: BbPluginApi["sdk"]["threads"]["listRunning"];
  send?: BbPluginApi["sdk"]["threads"]["send"];
  events?: (args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0]) => Promise<ThreadEventRow[]>;
  terminals?: BbPluginApi["sdk"]["terminals"]["list"];
  subscribe?: BbPluginApi["sdk"]["subscribe"];
  archive?: BbPluginApi["sdk"]["threads"]["archive"];
  update?: BbPluginApi["sdk"]["threads"]["update"];
  clearContext?: BbPluginApi["sdk"]["threads"]["clearContext"];
  interactions?: BbPluginApi["sdk"]["threads"]["interactions"]["list"];
  queuedMessages?: BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"];
} = {}) {
  const parents = new Map<string, string | null>();
  const parentOf = (threadId: string) => parents.has(threadId) ? parents.get(threadId)! : (threadId === "manager-1" ? null : "manager-1");
  const host = createFakePluginHost({
    pluginId: "feed",
    agentSkillIds: ["feed"],
    settings: options.settings ?? {
      managerThreadId: options.managerThreadId ?? "manager-1",
    },
    sdk: {
      subscribe: options.subscribe ?? (() => () => {}),
      threads: {
        get:
          options.get ??
          (async ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              title: threadId === "manager-1" ? "Manager" : `Title ${threadId}`,
              parentThreadId: parentOf(threadId),
            })),
        list:
          options.list ??
          (async (args) => {
            const child = listEntry("child-1", { parentThreadId: parentOf("child-1") });
            return args?.hasParent === false
              ? child.parentThreadId === null ? [child] : []
              : child.parentThreadId === args?.parentThreadId ? [child] : [];
          }),
        listRunning: options.running ?? (async () => []),
        send:
          options.send ??
          (async () => ({ ok: true, delivery: "sent" })),
        events: {
          list: options.events ?? (async () => []),
        },
        archive:
          options.archive ??
          (async ({ threadId }) => ({ archivedThreadIds: [threadId], ok: true })),
        clearContext: options.clearContext ?? (async () => ({ ok: true })),
        interactions: { list: options.interactions ?? (async () => []) },
        queuedMessages: { list: options.queuedMessages ?? (async () => []) },
        update: options.update ?? (async ({ threadId, parentThreadId }) => {
          if (parentThreadId !== undefined) parents.set(threadId, parentThreadId);
          return makeThreadResponse({ id: threadId, parentThreadId: parentOf(threadId) });
        }),
      },
      terminals: {
        list: options.terminals ?? (async () => ({ sessions: [] })),
      },
    },
  });
  await plugin(host.bb);
  return host;
}

describe("queue discovery and snapshots", () => {
  it("invalidates the queue for public native-terminal change signals", async () => {
    const changes = terminalChanges();
    const host = await configuredHost({ subscribe: changes.subscribe });
    const service = host.harness.behavior.runService(
      "thread-change-listener",
    );
    await vi.waitFor(() => {
      expect(host.harness.inspection.sdk.callsTo("subscribe")).toHaveLength(1);
    });

    changes.emit("child-1");

    await vi.waitFor(() => {
      expect(host.harness.inspection.realtimeSignals).toContainEqual({
        channel: "feed-invalidated",
        payload: { threadId: "child-1", reason: "thread-changed" },
      });
    });
    service.controller.abort();
    await service.done;
  });

  it("pages hidden cross-project direct children without a project filter and excludes grandchildren", async () => {
    const direct = Array.from({ length: 101 }, (_, index) =>
      listEntry(`child-${index}`, {
        projectId: index % 2 === 0 ? "project-a" : "project-b",
        visibility: index === 3 ? "hidden" : "visible",
      }),
    );
    const grandchild = listEntry("grandchild", {
      parentThreadId: "child-1",
    });
    const host = await configuredHost({
      list: async (args) => {
        const { offset = 0, limit = 100, parentThreadId } = args ?? {};
        return [...direct, grandchild]
          .filter((thread) => thread.parentThreadId === parentThreadId)
          .slice(offset, offset + limit);
      },
    });

    const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<{ id: string }> };

    expect(snapshot.rows).toHaveLength(101);
    expect(snapshot.rows.some((row) => row.id === "child-3")).toBe(true);
    expect(snapshot.rows.some((row) => row.id === "grandchild")).toBe(false);
    expect(
      host.harness.inspection.sdk
        .callsTo("threads.list")
        .filter(([args]) =>
          (args as { parentThreadId?: string }).parentThreadId === "manager-1",
        ),
    ).toEqual([
      [
        {
          parentThreadId: "manager-1",
          archived: false,
          includeHidden: true,
          limit: 100,
          offset: 0,
        },
      ],
      [
        {
          parentThreadId: "manager-1",
          archived: false,
          includeHidden: true,
          limit: 100,
          offset: 100,
        },
      ],
    ]);
  });

  it.each(["starting", "running"] as const)(
    "projects an idle child with a %s scoped native terminal as In progress",
    async (terminalStatus) => {
      const host = await configuredHost({
        list: async () => [listEntry("terminal-child", { status: "idle" })],
        terminals: async () => ({
          sessions: [
            terminalSession("terminal-1", "terminal-child", terminalStatus),
          ],
        }),
      });

      const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
        surfaceThreadId: "manager-1",
      })) as {
        rows: Array<{
          id: string;
          section: string;
          state: string;
          statusLabel: string;
        }>;
      };

      expect(snapshot.rows).toEqual([
        expect.objectContaining({
          id: "terminal-child",
          section: "in_progress",
          state: "running",
          statusLabel: "Active",
        }),
      ]);
      expect(host.harness.inspection.sdk.callsTo("terminals.list")).toEqual([
        [{ scope: { kind: "thread", threadId: "terminal-child" } }],
      ]);
    },
  );

  it("does not treat disconnected or exited native terminals as active", async () => {
    const host = await configuredHost({
      list: async () => [
        listEntry("disconnected-child", { status: "idle" }),
        listEntry("exited-child", { status: "idle" }),
      ],
      terminals: async ({ scope }) => {
        if (scope.kind !== "thread") throw new Error("Expected thread scope");
        return {
          sessions: [
            terminalSession(
              `terminal-${scope.threadId}`,
              scope.threadId,
              scope.threadId === "disconnected-child"
                ? "disconnected"
                : "exited",
            ),
          ],
        };
      },
    });

    const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as {
      rows: Array<{
        id: string;
        section: string;
        statusLabel: string;
      }>;
    };

    expect(
      snapshot.rows.map((row) => [row.id, row.section, row.statusLabel]),
    ).toEqual([
      ["disconnected-child", "in_progress", "With manager"],
      ["exited-child", "in_progress", "With manager"],
    ]);
  });

  it("projects idle owners as active for shallow and deep descendants", async () => {
    const parents = new Map([
      ["active-child", "owner-shallow"],
      ["depth-3", "depth-2"],
      ["depth-2", "depth-1"],
      ["depth-1", "owner-deep"],
    ]);
    const host = await configuredHost({
      list: async () => [listEntry("owner-shallow"), listEntry("owner-deep")],
      running: async () => [
        runningThread("active-child"),
        runningThread("depth-3"),
      ],
      get: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          parentThreadId:
            threadId === "manager-1" ? null : (parents.get(threadId) ?? null),
        }),
    });

    const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as {
      rows: Array<{
        id: string;
        section: string;
        state: string;
        statusLabel: string;
      }>;
    };

    expect(
      snapshot.rows.map((row) => [
        row.id,
        row.section,
        row.state,
        row.statusLabel,
      ]),
    ).toEqual([
      ["owner-deep", "in_progress", "running", "Active"],
      ["owner-shallow", "in_progress", "running", "Active"],
    ]);
    expect(host.harness.inspection.sdk.callsTo("threads.listRunning")).toEqual([
      [],
    ]);
  });

  it("bounds and caches ancestry lookups and stops on cycles", async () => {
    const runningLeaves = Array.from({ length: 20 }, (_, index) =>
      runningThread(`leaf-${index}`),
    );
    let activeLeafLookups = 0;
    let maximumActiveLeafLookups = 0;
    let startedLeafLookups = 0;
    let sharedParentLookups = 0;
    let release!: () => void;
    let workersStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstWave = new Promise<void>((resolve) => {
      workersStarted = resolve;
    });
    const host = await configuredHost({
      list: async () => [listEntry("owner")],
      running: async () => [...runningLeaves, runningThread("cycle-a")],
      get: async ({ threadId }) => {
        if (threadId === "manager-1") {
          return makeThreadResponse({ id: threadId, parentThreadId: null });
        }
        if (threadId.startsWith("leaf-")) {
          activeLeafLookups += 1;
          startedLeafLookups += 1;
          maximumActiveLeafLookups = Math.max(
            maximumActiveLeafLookups,
            activeLeafLookups,
          );
          if (startedLeafLookups === 8) workersStarted();
          await gate;
          activeLeafLookups -= 1;
          return makeThreadResponse({
            id: threadId,
            parentThreadId: "shared-parent",
          });
        }
        if (threadId === "shared-parent") {
          sharedParentLookups += 1;
          return makeThreadResponse({ id: threadId, parentThreadId: "owner" });
        }
        return makeThreadResponse({
          id: threadId,
          parentThreadId: threadId === "cycle-a" ? "cycle-b" : "cycle-a",
        });
      },
    });

    const loading = host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    });
    await firstWave;
    const firstWaveSize = startedLeafLookups;
    release();
    const snapshot = (await loading) as {
      rows: Array<{ id: string; section: string }>;
    };

    expect(firstWaveSize).toBe(8);
    expect(maximumActiveLeafLookups).toBeLessThanOrEqual(8);
    expect(sharedParentLookups).toBe(1);
    expect(
      host.harness.inspection.sdk
        .callsTo("threads.get")
        .filter(([input]) =>
          ["cycle-a", "cycle-b"].includes(
            (input as { threadId: string }).threadId,
          ),
        ),
    ).toHaveLength(2);
    expect(snapshot.rows).toEqual([
      expect.objectContaining({ id: "owner", section: "in_progress" }),
    ]);
  });

  it("shows the oldest result first in Needs your response", async () => {
    const host = await configuredHost({
      list: async () => [
        listEntry("older-result", {
          title: "Older result",
          updatedAt: 1_800_000_000_000,
        }),
        listEntry("newer-result", {
          title: "Newer result",
          updatedAt: 1_700_000_000_000,
        }),
      ],
      events: async ({ threadId }) => [
        completion(threadId, threadId === "older-result" ? 5 : 9),
      ],
    });
    for (const threadId of ["newer-result", "older-result"]) {
      await host.harness.behavior.callAgentTool(
        "feed_mark",
        { threadId },
        { threadId: "manager-1" },
      );
    }

    const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<{ section: string; title: string }> };

    expect(
      snapshot.rows
        .filter((row) => row.section === "needs_response")
        .map((row) => row.title),
    ).toEqual(["Older result", "Newer result"]);
  });

  it("deduplicates changing pages and keeps the latest row for each thread ID", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      listEntry(`child-${index}`, {
        title: index === 0 ? "Old title" : `Title child-${index}`,
      }),
    );
    const host = await configuredHost({
      list: async (args) =>
        (args?.offset ?? 0) === 0
          ? firstPage
          : [listEntry("child-0", { title: "Latest title" })],
    });

    const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<{ id: string; title: string }> };

    expect(snapshot.rows).toHaveLength(100);
    expect(snapshot.rows.filter((row) => row.id === "child-0")).toEqual([
      expect.objectContaining({ title: "Latest title" }),
    ]);
  });
  it("bounds per-child completion and terminal lookups while preserving results", async () => {
    const children = Array.from({ length: 20 }, (_, index) =>
      listEntry(`child-${index}`),
    );
    let activeTerminalLookups = 0;
    let maximumActiveTerminalLookups = 0;
    let startedTerminalLookups = 0;
    let release!: () => void;
    let workersStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstWave = new Promise<void>((resolve) => {
      workersStarted = resolve;
    });
    const host = await configuredHost({
      list: async () => children,
      events: async ({ threadId }) => [
        completion(threadId, Number(threadId.split("-")[1]) + 1),
      ],
      terminals: async () => {
        activeTerminalLookups += 1;
        startedTerminalLookups += 1;
        maximumActiveTerminalLookups = Math.max(
          maximumActiveTerminalLookups,
          activeTerminalLookups,
        );
        if (startedTerminalLookups === 8) workersStarted();
        await gate;
        activeTerminalLookups -= 1;
        return { sessions: [] };
      },
    });

    const loading = host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    });
    await firstWave;
    const firstWaveSize = startedTerminalLookups;
    release();
    const snapshot = (await loading) as {
      rows: Array<{ id: string; latestCompletionSeq: number }>;
    };

    expect(firstWaveSize).toBe(8);
    expect(maximumActiveTerminalLookups).toBeLessThanOrEqual(8);
    expect(
      host.harness.inspection.sdk
        .callsTo("threads.events.list")
        .filter(([args]) =>
          (args as { types?: string[] }).types?.[0] === "turn/completed",
        ),
    ).toHaveLength(20);
    expect(host.harness.inspection.sdk.callsTo("terminals.list")).toHaveLength(
      20,
    );
    expect(snapshot.rows).toHaveLength(20);
    expect(snapshot.rows.find((row) => row.id === "child-0")).toMatchObject({
      latestCompletionSeq: 1,
    });
    expect(snapshot.rows.find((row) => row.id === "child-19")).toMatchObject({
      latestCompletionSeq: 20,
    });
  });

  it("uses the cheap trimmed-manager guard without loading the queue", async () => {
    const host = await configuredHost({ managerThreadId: "  manager-1  " });
    const initialGetCalls = host.harness.inspection.sdk.callsTo("threads.get").length;

    await expect(
      host.harness.behavior.callRpc("canOpen", {
        surfaceThreadId: "other-thread",
      }),
    ).resolves.toEqual({ canOpen: false });
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(
      initialGetCalls,
    );

    await expect(
      host.harness.behavior.callRpc("canOpen", {
        surfaceThreadId: "manager-1",
      }),
    ).resolves.toEqual({ canOpen: true });
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(
      initialGetCalls + 1,
    );
    expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([]);
    expect(host.harness.inspection.sdk.callsTo("threads.events.list")).toEqual(
      [],
    );
  });

  it("silently rejects the action guard when no manager is configured", async () => {
    const host = createFakePluginHost({ pluginId: "feed" });
    await plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("canOpen", {
        surfaceThreadId: "any-thread",
      }),
    ).resolves.toEqual({ canOpen: false });
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toEqual([]);
  });

  it("rejects another surface and fails explicitly on an unknown BB tuple", async () => {
    const host = await configuredHost({
      list: async () => [listEntry("child-1", { status: "paused" as never })],
    });
    await expect(
      host.harness.behavior.callRpc("queueSnapshot", {
        surfaceThreadId: "other-thread",
      }),
    ).rejects.toThrow(/configured manager thread/i);
    await expect(
      host.harness.behavior.callRpc("queueSnapshot", {
        surfaceThreadId: "manager-1",
      }),
    ).rejects.toThrow("Unsupported BB thread status: paused");
  });
});

describe("read-only queue command", () => {
  it("prints projected queue fields as text and JSON without a write", async () => {
    const host = await configuredHost({ list: async () => [listEntry("child-1", { title: "A\nchild" })] });
    const plain = await host.harness.behavior.runCli(["show"], { threadId: "manager-1" });
    expect(plain).toEqual({ exitCode: 0, stderr: "", stdout: 'ID\tTITLE\tSECTION\tSTATE\tSTATUS\tSTARRED\tMANAGED\tSUMMARY\n"child-1"\t"A\\nchild"\t"in_progress"\t"with_manager"\t"With manager"\tfalse\ttrue\tnull\n' });
    const json = await host.harness.behavior.runCli(["show", "--json"], { threadId: "manager-1" });
    expect(JSON.parse(json.stdout)).toEqual([{ id: "child-1", title: "A\nchild", section: "in_progress", state: "with_manager", status: "With manager", starred: false, managedChild: true, oneLine: null, summarizing: false, latestMessage: null }]);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
  });

  it("rejects other callers and invalid flags", async () => {
    const host = await configuredHost();
    expect((await host.harness.behavior.runCli(["show"], { threadId: "other" })).exitCode).toBe(1);
    expect(await host.harness.behavior.runCli(["show", "--write"], { threadId: "manager-1" })).toEqual({ exitCode: 2, stdout: "", stderr: "Usage: bb feed show [--json]\n" });
  });
});

describe("manager context clear", () => {
  it("checks authorization and idle safety before clearing", async () => {
    const host = await configuredHost({
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: "active", queuedMessageCount: 1 }),
    });
    await expect(host.harness.behavior.callRpc("clearManager", { surfaceThreadId: "other" })).rejects.toThrow(/configured manager thread/);
    await expect(host.harness.behavior.callRpc("clearManager", { surfaceThreadId: "manager-1" })).rejects.toThrow(/idle with no queued work/);
    expect(host.harness.inspection.sdk.callsTo("threads.clearContext")).toEqual([]);
  });

  it("asks the manager to load the skill after clearing without pasting its body", async () => {
    const host = await configuredHost();
    await expect(host.harness.behavior.callRpc("clearManager", { surfaceThreadId: "manager-1" })).resolves.toEqual({ cleared: true });
    const sent = host.harness.inspection.sdk.callsTo("threads.send");
    expect(host.harness.inspection.sdk.callsTo("threads.clearContext")).toEqual([[{ threadId: "manager-1" }]]);
    expect(sent).toHaveLength(1);
    const message = (sent[0]![0] as { input: Array<{ text: string }> }).input[0]!.text;
    expect(message).toBe(
      "[feed] Your context was cleared. Load the feed skill and follow it. This thread is already bound, so skip the Bind step.\n\n" +
      "Run `bb feed show`, then run `bb thread history manager-1 --limit 5` to read the user's 5 most recent messages. Reply in one line that you are ready.",
    );
  });

});

describe("inline replies", () => {
  it("routes exact untrimmed plain text to the authorized direct child", async () => {
    const host = await configuredHost();
    const text = "  Keep leading space\nAnd trailing space  \n";

    await expect(
      host.harness.behavior.callRpc("sendReply", {
        surfaceThreadId: "manager-1",
        threadId: "child-1",
        text,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([
      [
        {
          threadId: "child-1",
          mode: "auto",
          input: [{ type: "text", text, mentions: [] }],
        },
      ],
    ]);
    expect(host.harness.inspection.realtimeSignals.at(-1)).toEqual({
      channel: "feed-invalidated",
      payload: { threadId: "child-1", reason: "reply-sent" },
    });
  });

  it("rejects unauthorized, non-child, and whitespace-only replies", async () => {
    const host = await configuredHost({
      get: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          parentThreadId:
            threadId === "manager-1"
              ? null
              : threadId === "other-child"
                ? "other-manager"
                : "manager-1",
        }),
    });

    await expect(
      host.harness.behavior.callRpc("sendReply", {
        surfaceThreadId: "other-manager",
        threadId: "child-1",
        text: "Hello",
      }),
    ).rejects.toThrow(/configured manager thread/i);
    await expect(
      host.harness.behavior.callRpc("sendReply", {
        surfaceThreadId: "manager-1",
        threadId: "other-child",
        text: "Hello",
      }),
    ).rejects.toThrow(/not a Feed thread/i);
    await expect(
      host.harness.behavior.callRpc("sendReply", {
        surfaceThreadId: "manager-1",
        threadId: "child-1",
        text: " \n\t ",
      }),
    ).rejects.toThrow(/rpc input validation failed/i);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  });
  it("does not publish a reply when BB rejects the send", async () => {
    const host = await configuredHost({
      send: async () => {
        throw new Error("Provider unavailable");
      },
    });

    await expect(
      host.harness.behavior.callRpc("sendReply", {
        surfaceThreadId: "manager-1",
        threadId: "child-1",
        text: "Please continue",
      }),
    ).rejects.toThrow("Provider unavailable");
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) =>
          (signal.payload as { reason?: string }).reason === "reply-sent",
      ),
    ).toEqual([]);
  });
});

describe("manager marks", () => {
  it("moves an idle managed child to Needs only after feed_mark", async () => {
    const host = await configuredHost({
      events: async ({ threadId }) => [completion(threadId, 21)],
    });

    let snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<Record<string, unknown>> };
    expect(snapshot.rows[0]).toMatchObject({
      section: "in_progress",
      state: "with_manager",
      statusLabel: "With manager",
    });

    await host.harness.behavior.callAgentTool(
      "feed_mark",
      { threadId: "child-1" },
      { threadId: "manager-1" },
    );
    snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<Record<string, unknown>> };
    expect(snapshot.rows[0]).toMatchObject({
      section: "needs_response",
      state: "needs_response",
      latestCompletionSeq: 21,
    });
  });

  it("returns one exact JSON result shape for expected tool outcomes", async () => {
    const unconfigured = createFakePluginHost({ pluginId: "feed" });
    await plugin(unconfigured.bb);
    await expect(
      unconfigured.harness.behavior.callAgentTool(
        "feed_mark",
        { threadId: "child-1" },
        { threadId: "manager-1" },
      ),
    ).resolves.toBe(JSON.stringify({ outcome: "not_configured" }));

    const active = await configuredHost({
      events: async ({ threadId }) => [completion(threadId, 3)],
    });
    await expect(
      active.harness.behavior.callAgentTool(
        "feed_mark",
        { threadId: "child-1" },
        { threadId: "other-thread" },
      ),
    ).resolves.toBe(JSON.stringify({ outcome: "wrong_caller" }));
    await expect(
      active.harness.behavior.callAgentTool(
        "feed_mark",
        { threadId: "child-1" },
        { threadId: "manager-1" },
      ),
    ).resolves.toBe(
      JSON.stringify({ outcome: "updated", threadId: "child-1", resultSeq: 3 }),
    );

    const absent = await configuredHost({
      get: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          parentThreadId: threadId === "manager-1" ? null : "other-manager",
        }),
    });
    await expect(
      absent.harness.behavior.callAgentTool(
        "feed_mark",
        { threadId: "child-1" },
        { threadId: "manager-1" },
      ),
    ).resolves.toBe(JSON.stringify({ outcome: "not_managed_child" }));
  });
  it("clears the mark when a new result arrives", async () => {
    let completionSeq = 10;
    const host = await configuredHost({
      events: async ({ threadId }) => [completion(threadId, completionSeq)],
    });
    await host.harness.behavior.callAgentTool(
      "feed_mark",
      { threadId: "child-1" },
      { threadId: "manager-1" },
    );
    completionSeq = 11;

    const snapshot = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<Record<string, unknown>> };
    expect(snapshot.rows[0]).toMatchObject({
      section: "in_progress",
      state: "with_manager",
      latestCompletionSeq: 11,
    });
  });
});

describe("row actions, configuration, and invalidation", () => {
  it.each([
    ["non-child", { parentThreadId: "other-manager" }],
    ["archived child", { archivedAt: 100 }],
    ["deleted child", { deletedAt: 100 }],
  ] as const)(
    "rejects archive and feed_mark for a %s",
    async (_name, override) => {
      const host = await configuredHost({
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            parentThreadId:
              threadId === "manager-1" ? null : "manager-1",
            ...(threadId === "manager-1" ? {} : override),
          }),
      });

      await expect(
        host.harness.behavior.callRpc("archiveThread", {
          surfaceThreadId: "manager-1",
          threadId: "child-1",
        }),
      ).rejects.toThrow(/not a Feed thread/i);
      const output = await host.harness.behavior.callAgentTool(
        "feed_mark",
        { threadId: "child-1" },
        { threadId: "manager-1" },
      );
      expect(toolResult(output)).toEqual({ outcome: "not_managed_child" });
      expect(host.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
      expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([]);
    },
  );
  it("detach moves a managed child to the user managed section without a manager notice", async () => {
    const host = await configuredHost({ settings: FULL_SETTINGS });

    await host.harness.behavior.callRpc("detach", {
      surfaceThreadId: "manager-1",
      threadId: "child-1",
    });

    expect(host.harness.inspection.sdk.callsTo("threads.update")).toEqual([
      [{ threadId: "child-1", parentThreadId: null, sectionId: "section-user" }],
    ]);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.filter(
        (signal) =>
          (signal.payload as { reason?: string }).reason === "detached",
      ),
    ).toHaveLength(1);
  });

  it("archive uses one validated RPC", async () => {
    const archived: string[] = [];
    const host = await configuredHost({
      archive: async ({ threadId }) => {
        archived.push(threadId);
        return { archivedThreadIds: [threadId], ok: true };
      },
    });
    await host.harness.behavior.callRpc("archiveThread", {
      surfaceThreadId: "manager-1",
      threadId: "child-1",
    });
    expect(archived).toEqual(["child-1"]);
  });
  it("keeps section root rows with live work and permits reply and archive", async () => {
    const host = await configuredHost({
      settings: FULL_SETTINGS,
      running: async () => [runningThread("leaf")],
      get: async ({ threadId }) => makeThreadResponse({
        id: threadId,
        parentThreadId: threadId === "leaf" ? "root-1" : null,
        sectionId: threadId === "root-1" ? "section-user" : null,
      }),
      list: async (args) =>
        args?.sectionId === "section-user"
          ? [listEntry("root-1", { parentThreadId: null, sectionId: "section-user", status: "idle" })]
          : [],
    });
    const target = { surfaceThreadId: "manager-1", threadId: "root-1" };
    const view = (await host.harness.behavior.callRpc("queueSnapshot", {
      surfaceThreadId: "manager-1",
    })) as { rows: Array<Record<string, unknown>> };
    expect(view.rows).toEqual([expect.objectContaining({
      id: "root-1", section: "in_progress", state: "running",
      statusLabel: "Active", starred: true, managedChild: false,
    })]);
    await host.harness.behavior.callRpc("sendReply", { ...target, text: "Continue" });
    await host.harness.behavior.callRpc("archiveThread", target);
    expect(host.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
      { threadId: "root-1", mode: "auto", input: [{ type: "text", text: "Continue", mentions: [] }] },
    ]]);
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "leaf", parentThreadId: "root-1", status: "active" }),
    });
    expect(host.harness.inspection.realtimeSignals.at(-1)?.payload).toEqual({
      threadId: "root-1", reason: "thread.active",
    });
  });

  it("drops the old annotation table and creates the Feed tables in the appended migration", async () => {
    const host = createFakePluginHost({
      pluginId: "feed",
      settings: { managerThreadId: "manager-1" },
      sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) } },
    });
    const database = host.bb.storage.database();
    host.bb.storage.migrate(database, INITIAL_SCHEMA_STATEMENTS.slice(0, 2));
    database.prepare("INSERT INTO queue_annotations (thread_id, user_managed) VALUES (?, 1)").run("old-child");
    await plugin(host.bb);
    const tables = (database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !name.startsWith("_"));
    expect(tables).toEqual([
      "feed_marks",
      "feed_pauses",
      "feed_summaries",
    ]);
  });
  it("exposes the skill everywhere and feed_mark with instructions only to the manager", async () => {
    const host = await configuredHost({ settings: FULL_SETTINGS });
    const config = await host.harness.behavior.resolveAgentConfiguration(
      agentContext("manager-1"),
    );
    expect(config.tools.map((tool) => tool.name)).toEqual(["feed_mark"]);
    expect(config.skills).toEqual(["feed"]);
    expect(config.instructions).toContain("--section section-children");
    expect(config.tools[0]?.instructions).toContain(
      "Calls accepted by the parameter schema return a JSON object",
    );
    expect(config.tools[0]?.instructions).toContain("outcome updated");
    expect(config.tools[0]?.instructions).toContain("runtime_error");
    const other = await host.harness.behavior.resolveAgentConfiguration(
      agentContext("other-thread"),
    );
    expect(other).toMatchObject({
      tools: [],
      skills: ["feed"],
      instructions: null,
    });
  });

  it("reports an archived configured manager as stale until reload", async () => {
    const host = createFakePluginHost({
      pluginId: "feed",
      settings: {
        managerThreadId: "manager-1",
        agentWritesEnabled: false,
      },
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({ id: "manager-1", archivedAt: 100 }),
        },
      },
    });
    await plugin(host.bb);
    expect(host.harness.inspection.needsConfigurationMessages.at(-1)).toMatch(
      /archived, deleted, or missing/,
    );
    expect(host.harness.inspection.logEntries.at(-1)?.message).toContain(
      "manager-1",
    );
  });

  it("reports a configured missing manager as needing configuration", async () => {
    const missing = Object.assign(new Error("not found"), { status: 404 });
    const host = createFakePluginHost({
      pluginId: "feed",
      settings: {
        managerThreadId: "manager-1",
        agentWritesEnabled: false,
      },
      sdk: {
        threads: {
          get: async () => {
            throw missing;
          },
        },
      },
    });
    await plugin(host.bb);

    expect(host.harness.inspection.needsConfigurationMessages.at(-1)).toMatch(
      /archived, deleted, or missing/,
    );
  });

  it("keeps needs-configuration set after a missing manager is corrected", async () => {
    const host = createFakePluginHost({
      pluginId: "feed",
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
        },
      },
    });
    await plugin(host.bb);
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([
      "Set managerThreadId, userManagedSectionId, childrenSectionId in the Feed plugin settings.",
    ]);

    await host.harness.behavior.setSettings({ managerThreadId: "manager-1" });
    await expect(
      host.harness.behavior.callRpc("canOpen", {
        surfaceThreadId: "manager-1",
      }),
    ).resolves.toEqual({ canOpen: true });
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([
      "Set managerThreadId, userManagedSectionId, childrenSectionId in the Feed plugin settings.",
      "Set userManagedSectionId, childrenSectionId in the Feed plugin settings.",
    ]);
  });

  it("marks configuration as needed when the manager setting is cleared", async () => {
    const host = await configuredHost({ settings: FULL_SETTINGS });
    const before = host.harness.inspection.needsConfigurationMessages.length;

    await host.harness.behavior.setSettings({ managerThreadId: null });

    expect(host.harness.inspection.needsConfigurationMessages.slice(before)).toEqual([
      "Set managerThreadId in the Feed plugin settings.",
    ]);
    await expect(
      host.harness.behavior.callRpc("canOpen", {
        surfaceThreadId: "manager-1",
      }),
    ).resolves.toEqual({ canOpen: false });
  });

  it("does not mark a transient manager lookup failure as configuration", async () => {
    const host = createFakePluginHost({
      pluginId: "feed",
      settings: FULL_SETTINGS,
      sdk: {
        threads: {
          get: async () => {
            throw new Error("temporary transport failure");
          },
        },
      },
    });
    await plugin(host.bb);

    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
    await expect(
      host.harness.behavior.callRpc("canOpen", {
        surfaceThreadId: "manager-1",
      }),
    ).rejects.toThrow(/could not verify/i);
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
  });

  it("applies manager setting changes without reload", async () => {
    const host = await configuredHost();
    await host.harness.behavior.setSettings({ managerThreadId: "manager-2" });

    const oldManager = await host.harness.behavior.resolveAgentConfiguration(
      agentContext("manager-1"),
    );
    const newManager = await host.harness.behavior.resolveAgentConfiguration(
      agentContext("manager-2"),
    );
    expect(oldManager.tools).toEqual([]);
    expect(newManager.tools.map((tool) => tool.name)).toEqual(["feed_mark"]);
    await expect(
      host.harness.behavior.callRpc("queueSnapshot", {
        surfaceThreadId: "manager-1",
      }),
    ).rejects.toThrow(/configured manager thread/i);
  });

  it("publishes invalidation for every relevant event and ignores unrelated threads", async () => {
    const host = await configuredHost({
      get: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          parentThreadId:
            threadId === "manager-1" || threadId === "other-manager"
              ? null
              : threadId === "unrelated"
                ? "other-manager"
                : "manager-1",
        }),
    });
    const direct = makeThreadResponse({
      id: "child-1",
      parentThreadId: "manager-1",
    });
    await host.harness.behavior.emitThreadEvent("thread.created", {
      thread: direct,
    });
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: { ...direct, status: "active" },
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: direct,
      lastAssistantText: "Done",
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: { ...direct, status: "error" },
      error: "Failed",
    });
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: { ...direct, archivedAt: 1 },
    });
    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: { ...direct, deletedAt: 1 },
    });
    await host.harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({ threadId: "child-1" }),
    });
    await host.harness.behavior.emitThreadEvent("message.dispatched", {
      entry: makeQueueEntry({ threadId: "child-1" }),
    });
    await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: "child-1" }),
    );
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "unrelated",
        parentThreadId: "other-manager",
        status: "active",
      }),
    });

    expect(host.harness.inspection.sdk.callsTo("threads.list")).toEqual([]);
    expect(
      host.harness.inspection.sdk
        .callsTo("threads.get")
        .filter(
          ([input]) =>
            (input as { threadId?: string }).threadId === "child-1",
        ),
    ).toHaveLength(7);
    expect(
      host.harness.inspection.realtimeSignals.map((signal) => signal.payload),
    ).toEqual([
      { threadId: "child-1", reason: "thread.created" },
      { threadId: "child-1", reason: "thread.active" },
      { threadId: "child-1", reason: "thread.idle" },
      { threadId: "child-1", reason: "thread.failed" },
      { threadId: "child-1", reason: "thread.archived" },
      { threadId: "child-1", reason: "thread.deleted" },
      { threadId: "child-1", reason: "message.queued" },
      { threadId: "child-1", reason: "message.dispatched" },
      { threadId: "child-1", reason: "turn.failed" },
    ]);
  });

  it("invalidates the owning row for descendant lifecycle changes", async () => {
    const host = await configuredHost({
      get: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          parentThreadId:
            threadId === "manager-1"
              ? null
              : threadId === "middle"
                ? "child-1"
                : threadId === "deep-descendant"
                  ? "middle"
                  : "manager-1",
        }),
    });
    const descendant = makeThreadResponse({
      id: "deep-descendant",
      parentThreadId: "middle",
    });

    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: { ...descendant, status: "active" },
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: descendant,
      lastAssistantText: "Done",
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: { ...descendant, status: "error" },
      error: "Failed",
    });
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: { ...descendant, archivedAt: 1 },
    });
    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: { ...descendant, deletedAt: 1 },
    });

    expect(
      host.harness.inspection.realtimeSignals.map((signal) => signal.payload),
    ).toEqual([
      { threadId: "child-1", reason: "thread.active" },
      { threadId: "child-1", reason: "thread.idle" },
      { threadId: "child-1", reason: "thread.failed" },
      { threadId: "child-1", reason: "thread.archived" },
      { threadId: "child-1", reason: "thread.deleted" },
    ]);
  });
});
