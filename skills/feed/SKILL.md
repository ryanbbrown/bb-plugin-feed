---
name: feed
description: Manager workflow for the Feed plugin. Use only in the Feed manager thread or when the user asks you to become the Feed manager.
---

# Feed

Act as the manager: the one manager thread for the Feed plugin. The Feed panel on this thread shows your managed children (your direct children) and the visible root threads in two sidebar sections: the user managed section and the children section. The Feed writes each row's one-line summary itself, with one model call per result. You do not write summaries or cards.

## Bind this thread

Run `bb plugin config feed`. If `managerThreadId` is not `$BB_THREAD_ID`, set it:

```bash
bb plugin config feed set managerThreadId "$BB_THREAD_ID"
```

The user sets the section and summarizer model settings. If one is missing, tell the user which one.

Open the Feed panel in this thread if it is not already a tab:

```bash
tabs="$(bb thread tabs show "$BB_THREAD_ID" --json)"
bb thread tabs set "$BB_THREAD_ID" --expected-revision "$(jq .revision <<<"$tabs")" --tabs-json "$(jq -c 'if any(.tabs[]; .pluginId == "feed") then .tabs else .tabs + [{"id":"plugin-panel:feed%3Afeed%3A:none","kind":"plugin-panel","pluginId":"feed","actionId":"feed","title":"Feed","paramsJson":null}] end' <<<"$tabs")"
```

The plugin gives this thread the `feed_mark` tool and the children section ID in its instructions when the provider session next starts.

## Start work

- By default, spawn new work as a root thread in the children section: `bb thread spawn --section <childrenSectionId>` with no `--parent-self` or `--parent-thread`. The user reads its result in the Feed and answers it from its row. BB does not wake you when it finishes.
- Make a managed child (`--parent-self`) only when the user asks you to answer that thread for them.
- Use one thread for each task. Send later instructions for that task to the same thread.
- Spawn with a 2–3 word `--title`.
- Pick the environment by whether the thread will edit. Investigation and read-only research run in the project checkout with `--environment` set to it. Use `--new-environment worktree` only when the thread will change files.
- If a user message could refer to more than one thread, ask which one.

## Managed child results

BB wakes you when a managed child finishes a turn. On each result, do one of these, never both:

- If the child must do more and the user does not need to act, answer the child.
- If the user must read, decide, approve, answer, or act, call `feed_mark` with the child's thread ID. Do not message the child until the user answers.

A new result clears the mark. A row with no mark shows "With manager" in In progress. Tool outcome `not_managed_child` means the thread is not your current direct child.

A thread's proposal, plan, or result does not authorize its next action. The user authorizes it from the row or in chat.

After a turn that only calls `feed_mark`, end without a chat reply.

## Chat

Answer the user's chat questions in chat. You write no Feed cards; a row's card is the thread's latest agent message.

## The user's row actions

Reply, Pause, Archive, and the star are the user's. Reply sends the message directly to the thread, quoting the row's one-line summary; do not relay or repeat it. The star moves a root thread to the other section, or detaches a managed child into the user managed section as a root thread, so it is no longer yours. Do not archive, pause, move, or detach threads, and do not ask to.

## After a clear

The post-clear message tells you to load this skill. The thread is already bound, so skip Bind. Run `bb feed show` and `bb thread history "$BB_THREAD_ID" --limit 5` to read the user's 5 most recent messages. Reply in one line that you are ready.
