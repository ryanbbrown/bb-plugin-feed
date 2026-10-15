import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The same helper-inference call that BB's bundled Codex plugin makes for thread titles.
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CHATGPT_AUTH_CLAIM_PATH = "https://api.openai.com/auth";
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

type CodexCredentials =
  | { type: "apiKey"; apiKey: string }
  | {
      type: "chatgpt";
      accessToken: string;
      accountId: string;
      isFedrampAccount: boolean;
    };

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function chatGptClaims(token: string): JsonObject | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const decoded = asObject(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return asObject(decoded?.[CHATGPT_AUTH_CLAIM_PATH]);
  } catch {
    return null;
  }
}

/** Reads the local Codex login, as BB's Codex host does; the token is used as stored. */
async function readCodexCredentials(): Promise<CodexCredentials> {
  const codexHome = path.resolve(
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
  );
  const authPath = path.join(codexHome, "auth.json");
  let parsed: JsonObject | null;
  try {
    parsed = asObject(JSON.parse(await readFile(authPath, "utf8")));
  } catch {
    throw new Error(`Codex auth file at ${authPath} is missing or not valid JSON. Run codex login.`);
  }
  const authMode = nonEmptyString(parsed?.auth_mode);
  const apiKey = nonEmptyString(parsed?.OPENAI_API_KEY);
  if (authMode === "apikey" || authMode === "apiKey" || (authMode === null && apiKey !== null)) {
    if (apiKey === null) throw new Error(`Codex auth file at ${authPath} has no API key.`);
    return { type: "apiKey", apiKey };
  }
  const tokens = asObject(parsed?.tokens);
  const accessToken = nonEmptyString(tokens?.access_token);
  if (accessToken === null) {
    throw new Error(`Codex auth file at ${authPath} has no access token. Run codex login.`);
  }
  const claims = chatGptClaims(accessToken);
  const idToken = nonEmptyString(tokens?.id_token);
  const idClaims = idToken === null ? null : chatGptClaims(idToken);
  const accountId =
    nonEmptyString(tokens?.account_id) ??
    nonEmptyString(claims?.chatgpt_account_id) ??
    nonEmptyString(idClaims?.chatgpt_account_id);
  if (accountId === null) {
    throw new Error("Codex auth tokens have no ChatGPT account ID. Run codex login.");
  }
  return {
    type: "chatgpt",
    accessToken,
    accountId,
    isFedrampAccount:
      claims?.chatgpt_account_is_fedramp === true ||
      idClaims?.chatgpt_account_is_fedramp === true,
  };
}

function requestHeaders(credentials: CodexCredentials): Headers {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "bb-host-daemon",
  });
  if (credentials.type === "apiKey") {
    headers.set("Authorization", `Bearer ${credentials.apiKey}`);
    return headers;
  }
  headers.set("Authorization", `Bearer ${credentials.accessToken}`);
  headers.set("chatgpt-account-id", credentials.accountId);
  headers.set("originator", "bb");
  headers.set("OpenAI-Beta", "responses=experimental");
  if (credentials.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
  return headers;
}

function outputText(response: JsonObject): string | null {
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    const content = asObject(item)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const object = asObject(part);
      const text = nonEmptyString(object?.text) ?? nonEmptyString(object?.output_text);
      if ((object?.type === "output_text" || object?.type === "text") && text !== null) {
        return text;
      }
    }
  }
  return null;
}

function streamFailure(event: JsonObject): string | null {
  if (event.type === "error") {
    return nonEmptyString(event.message) ?? nonEmptyString(event.code) ?? "The model call failed.";
  }
  const error = asObject(asObject(event.response)?.error);
  if (event.type === "response.failed" || error !== null) {
    return nonEmptyString(error?.message) ?? nonEmptyString(error?.code) ?? "The model call failed.";
  }
  return null;
}

/** Reads the server-sent events and returns the structured output text. */
async function readStreamText(response: Response): Promise<string> {
  if (response.body === null) throw new Error("The model response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let finalText: string | null = null;
  let totalBytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error("The model response is too large.");
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const data = buffer
        .slice(0, index)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
      if (!data || data === "[DONE]") continue;
      const event = asObject(JSON.parse(data));
      if (event === null) continue;
      const failure = streamFailure(event);
      if (failure !== null) throw new Error(failure);
      if (event.type === "response.output_text.delta") {
        deltaText += nonEmptyString(event.delta) ?? "";
      } else if (event.type === "response.completed" || event.type === "response.done") {
        const response = asObject(event.response);
        finalText = (response === null ? null : outputText(response)) ?? finalText;
      }
    }
  }
  const text = finalText ?? deltaText;
  if (!text) throw new Error("The model response has no output text.");
  return text;
}

/** One structured model call that returns `{ oneLine }`. */
export async function requestOneLine(input: {
  model: string;
  instructions: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  const credentials = await readCodexCredentials();
  const body = {
    model: input.model,
    instructions: input.instructions,
    reasoning: { effort: "none" },
    store: false,
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }],
    text: {
      format: {
        type: "json_schema",
        name: "result",
        strict: true,
        schema: {
          type: "object",
          properties: { oneLine: { type: "string" } },
          required: ["oneLine"],
          additionalProperties: false,
        },
      },
    },
  };
  const response = await fetch(
    credentials.type === "chatgpt" ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: requestHeaders(credentials),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs),
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new Error(`The model call failed with HTTP ${response.status}: ${detail}`);
  }
  const value = asObject(JSON.parse(await readStreamText(response)));
  const oneLine = nonEmptyString(value?.oneLine);
  if (oneLine === null) throw new Error("The model response has no oneLine.");
  return oneLine;
}
