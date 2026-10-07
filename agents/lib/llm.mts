/**
 * The agents' only way to call a language model: any OpenAI-compatible
 * `/chat/completions` endpoint, chosen entirely through configuration so a fork
 * can switch providers without a code change.
 *
 * Every client enforces a token budget for the whole agent run. Before a call
 * is sent, its worst case (estimated prompt plus the reply limit) is reserved,
 * and the call is refused if that doesn't fit. Afterwards the reservation is
 * settled to the reported usage, or kept in full when the outcome is unknown
 * (timeouts, unreadable replies, missing usage). Prompt sizes are estimates, so
 * a call can still overshoot by the estimation error; it then fails with
 * `cap_exceeded`, and the caller is expected to stop and hand the request to a
 * human.
 *
 * Nothing here logs or returns the API key, prompts, replies or provider error
 * text.
 */

export type LlmErrorKind =
  | "config" // missing or invalid configuration or arguments
  | "auth" // the provider rejected the key
  | "rate_limited" // still rate limited after retries
  | "provider" // any other provider or network failure
  | "bad_response" // the reply wasn't a usable chat completion
  | "cap_exceeded"; // the run's token budget is used up

export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
  }
}

export const isTokenCapExceeded = (error: unknown): boolean =>
  error instanceof LlmError && error.kind === "cap_exceeded";

export interface LlmConfig {
  /** Endpoint base, without a trailing slash, e.g. `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  model: string;
  /** Not enumerable on configs from `readLlmConfig`, so logging a config doesn't print it. */
  apiKey: string;
  /** Token budget for one agent run (prompt and reply tokens together). */
  maxTokensPerRun: number;
}

export const DEFAULT_MAX_TOKENS_PER_RUN = 50_000;
const MAX_TOKENS_PER_RUN_LIMIT = 2_000_000;

const isTokenCount = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

type Env = Record<string, string | undefined>;

/**
 * Read the LLM settings from the environment (Actions secrets and variables).
 * Fails closed: anything missing or invalid throws a `config` error naming the
 * setting, never its value.
 */
export function readLlmConfig(env: Env = process.env): LlmConfig {
  const value = (name: string) => env[name]?.trim() ?? "";
  const missing = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"].filter((name) => !value(name));
  if (missing.length > 0) {
    throw new LlmError("config", `Missing configuration: ${missing.join(", ")}`);
  }

  let url: URL;
  try {
    url = new URL(value("LLM_BASE_URL"));
  } catch {
    throw new LlmError("config", "LLM_BASE_URL is not a valid URL");
  }
  // The key travels in a header: only send it over TLS, and never to a URL
  // that carries its own credentials, query or fragment.
  const raw = value("LLM_BASE_URL");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw new LlmError("config", "LLM_BASE_URL must be a plain https:// URL");
  }

  const model = value("LLM_MODEL");
  if (model.length > 200 || /\s/.test(model)) {
    throw new LlmError("config", "LLM_MODEL must be a single model id");
  }
  // Printable ASCII only: anything else would make fetch fail on the header,
  // and its error message would echo the value.
  const apiKey = value("LLM_API_KEY");
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new LlmError("config", "LLM_API_KEY contains invalid characters");
  }

  // Per agent run, despite the name: one workflow run of one agent.
  let maxTokensPerRun = DEFAULT_MAX_TOKENS_PER_RUN;
  const cap = value("LLM_MAX_TOKENS_PER_REQUEST");
  if (cap) {
    maxTokensPerRun = /^\d+$/.test(cap) ? Number(cap) : Number.NaN;
    if (!isTokenCount(maxTokensPerRun, MAX_TOKENS_PER_RUN_LIMIT)) {
      throw new LlmError(
        "config",
        `LLM_MAX_TOKENS_PER_REQUEST must be a whole number from 1 to ${MAX_TOKENS_PER_RUN_LIMIT}`,
      );
    }
  }

  const config = {
    baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    model,
    maxTokensPerRun,
  } as LlmConfig;
  Object.defineProperty(config, "apiKey", { value: apiKey, enumerable: false });
  return config;
}

export type ContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatOptions {
  /** Upper bound for the reply; lowered automatically to what the budget allows. */
  maxOutputTokens: number;
  /** Sent only when set; some models reject anything but their default. */
  temperature?: number;
  /** Per attempt, including reading the reply. Default 5 minutes. */
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  /** `stop` for a complete reply; anything else (`length`, `content_filter`, …) means incomplete. */
  finishReason: string;
  /** Tokens this call counted against the budget. */
  tokens: number;
  /** True when the provider didn't report usage and the worst case was counted. */
  estimated: boolean;
}

export interface LlmClient {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;
  /** Tokens counted so far in this run, including calls still in flight. */
  readonly tokensUsed: number;
}

export interface LlmDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Operational events (retries only); never content. */
  log: (event: string, fields: Record<string, number>) => void;
}

const defaultDeps: LlmDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (event, fields) =>
    console.error(
      JSON.stringify({ ...fields, level: "warn", event, time: new Date().toISOString() }),
    ),
};

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 30_000;
/** Rough token weight of one image; providers vary widely, so err high. */
const IMAGE_TOKEN_ESTIMATE = 1_500;

/**
 * UTF-8 bytes / 3: overcounts English prose (about 4 characters per token),
 * roughly matches code and JSON, and counts about one token per character for
 * scripts such as Chinese or Japanese.
 */
const estimateTextTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);

export function estimatePromptTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4; // role and framing overhead
    if (typeof message.content === "string") {
      total += estimateTextTokens(message.content);
      continue;
    }
    for (const part of message.content) {
      total += part.type === "text" ? estimateTextTokens(part.text) : IMAGE_TOKEN_ESTIMATE;
    }
  }
  return total;
}

/** A short operator hint per status; provider error bodies are never read. */
function failureFor(status: number): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError("auth", `LLM provider rejected the request (${status}); check LLM_API_KEY`);
  }
  if (status === 402) {
    return new LlmError("provider", "LLM provider refused for billing or credit reasons (402)");
  }
  if (status === 404) {
    return new LlmError(
      "provider",
      "LLM endpoint or model not found (404); check LLM_BASE_URL and LLM_MODEL",
    );
  }
  if (status === 429) {
    return new LlmError("rate_limited", "LLM provider is rate limiting requests (429)");
  }
  if (status === 400 || status === 422) {
    return new LlmError(
      "provider",
      `LLM provider rejected the request (${status}); check that LLM_MODEL supports it (context length, parameters)`,
    );
  }
  return new LlmError("provider", `LLM provider request failed (${status})`);
}

/** Retry-After in seconds (the HTTP-date form is ignored), else exponential backoff. */
function retryDelay(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * 2 ** (attempt - 1);
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

type RawCompletion = {
  choices?: { message?: { content?: unknown } | null; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | null;
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;

/** Reported usage (the larger of the total and its parts), or null when none was reported. */
function reportedTokens(usage: RawCompletion["usage"]): number | null {
  const tokens = Math.max(
    count(usage?.total_tokens),
    count(usage?.prompt_tokens) + count(usage?.completion_tokens),
  );
  return tokens > 0 ? tokens : null;
}

export function createLlmClient(config: LlmConfig, deps: LlmDeps = defaultDeps): LlmClient {
  if (
    !isTokenCount(config.maxTokensPerRun, MAX_TOKENS_PER_RUN_LIMIT) ||
    !config.baseUrl.startsWith("https://")
  ) {
    throw new LlmError("config", "Invalid LLM configuration; build it with readLlmConfig");
  }
  let used = 0;

  /**
   * POST with retries on rate limits and server errors (not billed). Network
   * failures and timeouts are not retried: the request may already be billed.
   * Returns the final response, which may be an error status.
   */
  async function send(body: string, timeoutMs: number): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await deps.fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "feature-bridge-agent",
          },
          body,
          // Never follow a redirect with the key attached.
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Fresh errors only: fetch's own message or cause can echo header values.
        throw new LlmError(
          "provider",
          isTimeout(error) ? "LLM request timed out" : "LLM request failed",
        );
      }
      if (response.ok || !RETRY_STATUSES.has(response.status) || attempt >= MAX_ATTEMPTS) {
        return response;
      }
      const delay = retryDelay(response, attempt);
      // A long Retry-After usually means a quota window: give up rather than wait.
      if (delay > MAX_RETRY_DELAY_MS) return response;
      await response.body?.cancel().catch(() => {});
      deps.log("llm.retry", { attempt, status: response.status, delayMs: delay });
      await deps.sleep(delay);
    }
  }

  return {
    get tokensUsed() {
      return used;
    },

    async chat(messages, options) {
      const { maxOutputTokens, temperature, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
      if (!isTokenCount(maxOutputTokens, MAX_TOKENS_PER_RUN_LIMIT)) {
        throw new LlmError("config", "maxOutputTokens must be a positive whole number");
      }
      if (temperature !== undefined && !(temperature >= 0 && temperature <= 2)) {
        throw new LlmError("config", "temperature must be between 0 and 2");
      }
      if (!isTokenCount(timeoutMs, MAX_TIMEOUT_MS)) {
        throw new LlmError("config", `timeoutMs must be a whole number up to ${MAX_TIMEOUT_MS}`);
      }

      const promptEstimate = estimatePromptTokens(messages);
      const outputAllowance = Math.min(
        maxOutputTokens,
        config.maxTokensPerRun - used - promptEstimate,
      );
      if (outputAllowance < 1) {
        throw new LlmError(
          "cap_exceeded",
          `Token cap reached: ${used} of ${config.maxTokensPerRun} used, about ${promptEstimate} more needed`,
        );
      }

      // Hold the worst case while the call is in flight, so overlapping calls
      // can't overspend, and keep it whenever the real usage is unknown.
      const reservation = promptEstimate + outputAllowance;
      used += reservation;
      let charge = reservation;
      let raw: RawCompletion;
      try {
        const response = await send(
          JSON.stringify({
            model: config.model,
            messages,
            max_tokens: outputAllowance,
            ...(temperature === undefined ? {} : { temperature }),
          }),
          timeoutMs,
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          charge = 0; // the provider refused, so nothing was generated
          throw failureFor(response.status);
        }
        try {
          raw = (await response.json()) as RawCompletion;
        } catch (error) {
          throw isTimeout(error)
            ? new LlmError("provider", "LLM request timed out")
            : new LlmError("bad_response", "LLM reply was not JSON");
        }
        // Never below the prompt estimate, so a proxy reporting 0 can't zero the run.
        charge = Math.max(reportedTokens(raw?.usage) ?? reservation, promptEstimate);
      } finally {
        used += charge - reservation;
      }

      // Budget first: a run over its cap stops even if this reply was usable.
      if (used > config.maxTokensPerRun) {
        throw new LlmError(
          "cap_exceeded",
          `Token cap exceeded: ${used} of ${config.maxTokensPerRun} used`,
        );
      }
      const choice = Array.isArray(raw?.choices) ? raw.choices[0] : undefined;
      const finishReason =
        typeof choice?.finish_reason === "string" && /^[a-z_]{1,32}$/.test(choice.finish_reason)
          ? choice.finish_reason
          : "unknown";
      const text = choice?.message?.content;
      if (typeof text !== "string") {
        throw new LlmError(
          "bad_response",
          `LLM reply had no message text (finish: ${finishReason})`,
        );
      }
      return { text, finishReason, tokens: charge, estimated: reportedTokens(raw?.usage) === null };
    },
  };
}
