import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { FeedAnswer } from "./contract.js";

/** The Answer Panel plugin's `read` output: the thread's answer.md or answer.html, whichever was written last. */
const answerPanelReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).passthrough(),
  z.object({ kind: z.literal("unchanged") }).passthrough(),
  z
    .object({
      kind: z.enum(["markdown", "html"]),
      sha256: z.string(),
      content: z.string(),
      baseUrl: z.string(),
      hostId: z.string(),
    })
    .passthrough(),
]);

/** The thread's answer file, or null when it has none or the Answer Panel plugin cannot read it. */
export async function readAnswer(
  bb: BbPluginApi,
  threadId: string,
): Promise<FeedAnswer | null> {
  try {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "answer-panel",
      method: "read",
      input: { threadId, knownSha256: null },
      outputSchema: answerPanelReadSchema,
    });
    if (result.kind !== "markdown" && result.kind !== "html") return null;
    return {
      kind: result.kind,
      sha256: result.sha256,
      content: result.content,
      baseUrl: result.baseUrl,
      hostId: result.hostId,
    };
  } catch {
    return null;
  }
}

/** Plain text of an HTML answer, for the summary call. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
}

export function answerText(answer: FeedAnswer): string {
  return answer.kind === "html" ? htmlToText(answer.content) : answer.content;
}
