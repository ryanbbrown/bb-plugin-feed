import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const feedSectionSchema = z.enum([
  "needs_response",
  "in_progress",
  "paused",
]);
export const rowStateSchema = z.enum([
  "running",
  "waiting",
  "with_manager",
  "needs_response",
  "error",
  "queued_failed",
]);

export const feedRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    section: feedSectionSchema,
    state: rowStateSchema,
    statusLabel: z.string(),
    oneLine: z.string().nullable(),
    summarizing: z.boolean(),
    latestMessage: z.string().nullable(),
    starred: z.boolean(),
    managedChild: z.boolean(),
    paused: z.boolean(),
    /** Set on a nested thread that waits on the user: the title of its parent thread. */
    parentTitle: z.string().nullable(),
    latestCompletionSeq: z.number().int().nonnegative(),
    answeredAt: z.number().int().nonnegative(),
  })
  .strict();

export type FeedRow = z.infer<typeof feedRowSchema>;
export type FeedSection = z.infer<typeof feedSectionSchema>;

const threadIdSchema = z.string().min(1).max(200);
const replyTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Reply text is required");

const surfaceInput = z
  .object({
    surfaceThreadId: threadIdSchema,
  })
  .strict();

const rowInput = surfaceInput.extend({ threadId: threadIdSchema }).strict();

export const rpcContract = defineRpcContract({
  canOpen: {
    input: surfaceInput,
    output: z.object({ canOpen: z.boolean() }).strict(),
  },
  queueSnapshot: {
    input: surfaceInput,
    output: z
      .object({
        managerThreadId: z.string(),
        sectionNames: z
          .object({ userManaged: z.string(), children: z.string() })
          .strict(),
        rows: z.array(feedRowSchema),
      })
      .strict(),
  },
  clearManager: {
    input: surfaceInput,
    output: z.object({ cleared: z.literal(true) }).strict(),
  },
  setPaused: {
    input: rowInput.extend({ paused: z.boolean() }).strict(),
    output: z.object({ threadId: z.string(), paused: z.boolean() }).strict(),
  },
  detach: {
    input: rowInput,
    output: z.object({ detached: z.literal(true) }).strict(),
  },
  moveSection: {
    input: rowInput,
    output: z.object({ sectionId: z.string() }).strict(),
  },
  archiveThread: {
    input: rowInput,
    output: z.object({ archived: z.literal(true) }).strict(),
  },
  sendReply: {
    input: rowInput.extend({ text: replyTextSchema }).strict(),
    output: z.object({ accepted: z.literal(true) }).strict(),
  },
});
