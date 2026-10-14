// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  type ChatMessage,
  type ChatOptions,
  DEFAULT_MAX_TOKENS_PER_RUN,
  type LlmConfig,
  LlmError,
  createLlmClient,
  estimatePromptTokens,
  isTokenCapExceeded,
  readLlmConfig,
} from "./llm.mts";

const KEY = "fake-llm-key-for-tests";

const env = {
  LLM_BASE_URL: "https://llm.example.test/api/v1/",
  LLM_MODEL: "vendor/model-1:free",
  LLM_API_KEY: KEY,
};

const config: LlmConfig = {
  baseUrl: "https://llm.example.test/api/v1",
  model: "vendor/model-1:free",
  apiKey: KEY,
  maxTokensPerRun: 10_000,
};

const messages: ChatMessage[] = [
  { role: "system", content: "You plan features." },
  { role: "user", content: "Plan a counter demo." },
];
const PROMPT = estimatePromptTokens(messages);
const opts: ChatOptions = { maxOutputTokens: 100 };

const completion = (text: unknown, usage: unknown = { total_tokens: 120 }, finish = "stop") =>
  Response.json({ choices: [{ message: { content: text }, finish_reason: finish }], usage });

/** A fake provider: replies in order, and records every request. */
function fakeProvider(...replies: (Response | Error)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = replies.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const log = vi.fn<(event: string, fields: Record<string, number>) => void>();
  return { fetch, sleep, log, deps: { fetch, sleep, log } };
}

const sentBody = (provider: ReturnType<typeof fakeProvider>, call = 0) =>
  JSON.parse(String(provider.fetch.mock.calls[call][1]?.body));

async function caught(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error("expected a rejection");
}

function thrown(fn: () => unknown): LlmError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error("expected a throw");
}

describe("readLlmConfig", () => {
  it("reads and normalises the settings, defaulting the token cap", () => {
    const read = readLlmConfig(env);
    expect(read).toEqual({
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokensPerRun: DEFAULT_MAX_TOKENS_PER_RUN,
    });
    expect(DEFAULT_MAX_TOKENS_PER_RUN).toBe(50_000);
    expect(readLlmConfig({ ...env, LLM_MAX_TOKENS_PER_REQUEST: " 8000 " }).maxTokensPerRun).toBe(
      8000,
    );
  });

  it("keeps the key usable but out of serialised output", () => {
    const read = readLlmConfig(env);
    expect(read.apiKey).toBe(KEY);
    expect(JSON.stringify(read)).not.toContain(KEY);
    expect(Object.keys(read)).not.toContain("apiKey");
  });

  it("names every missing setting without printing any values", () => {
    const error = thrown(() => readLlmConfig({ LLM_MODEL: "  ", LLM_API_KEY: "secret-value" }));
    expect(error.kind).toBe("config");
    expect(error.message).toBe("Missing configuration: LLM_BASE_URL, LLM_MODEL");
    expect(error.message).not.toContain("secret-value");
  });

  it.each([
    ["http://llm.example.test/v1", "plain https"],
    ["https://user:pass@llm.example.test/v1", "plain https"],
    ["https://llm.example.test/v1?key=x", "plain https"],
    ["https://llm.example.test/v1?", "plain https"],
    ["https://llm.example.test/v1#", "plain https"],
    ["not a url", "not a valid URL"],
  ])("rejects base URL %s", (LLM_BASE_URL, message) => {
    expect(() => readLlmConfig({ ...env, LLM_BASE_URL })).toThrow(message);
  });

  it("rejects malformed models, keys and caps without echoing them", () => {
    expect(() => readLlmConfig({ ...env, LLM_MODEL: "two words" })).toThrow("single model id");
    expect(() => readLlmConfig({ ...env, LLM_MODEL: "m".repeat(201) })).toThrow("single model id");
    for (const key of ["a\nb", "a\u0000b", "ключ-key"]) {
      const error = thrown(() => readLlmConfig({ ...env, LLM_API_KEY: key }));
      expect(error.message).toBe("LLM_API_KEY contains invalid characters");
    }
    for (const cap of ["0", "-5", "1.5", "lots", "2000001"]) {
      expect(() => readLlmConfig({ ...env, LLM_MAX_TOKENS_PER_REQUEST: cap })).toThrow(
        "LLM_MAX_TOKENS_PER_REQUEST",
      );
    }
  });
});

describe("estimatePromptTokens", () => {
  it("counts UTF-8 bytes / 3 plus framing, and a fixed weight per image", () => {
    expect(estimatePromptTokens([{ role: "user", content: "x".repeat(400) }])).toBe(4 + 134);
    // Multi-byte scripts count about one token per character.
    expect(estimatePromptTokens([{ role: "user", content: "中文测试" }])).toBe(4 + 4);
    expect(
      estimatePromptTokens([
        {
          role: "user",
          content: [
            { type: "text", text: "abcd" },
            { type: "image_url", image_url: { url: "https://img.example.test/a.png" } },
          ],
        },
      ]),
    ).toBe(4 + 2 + 1500);
  });
});

describe("createLlmClient", () => {
  it("refuses hand-built configs that would disable the cap or drop TLS", () => {
    for (const bad of [
      { ...config, maxTokensPerRun: Number.NaN },
      { ...config, maxTokensPerRun: Number.POSITIVE_INFINITY },
      { ...config, maxTokensPerRun: 0 },
      { ...config, baseUrl: "http://llm.example.test/v1" },
    ]) {
      expect(thrown(() => createLlmClient(bad, fakeProvider().deps)).kind).toBe("config");
    }
  });

  it("posts an OpenAI-compatible request and returns the reply", async () => {
    const provider = fakeProvider(completion("1. Add a page"));
    const client = createLlmClient(config, provider.deps);

    const result = await client.chat(messages, { maxOutputTokens: 2000 });

    expect(result).toEqual({
      text: "1. Add a page",
      finishReason: "stop",
      tokens: 120,
      estimated: false,
    });
    expect(client.tokensUsed).toBe(120);
    const [url, init] = provider.fetch.mock.calls[0];
    expect(url).toBe("https://llm.example.test/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    // No temperature unless the caller asks: some models reject it.
    expect(sentBody(provider)).toEqual({
      model: "vendor/model-1:free",
      messages,
      max_tokens: 2000,
    });
  });

  it("passes temperature and image parts through unchanged", async () => {
    const provider = fakeProvider(completion("ok"));
    const withImage: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image_url", image_url: { url: "https://img.example.test/a.png" } },
        ],
      },
    ];
    await createLlmClient(config, provider.deps).chat(withImage, { ...opts, temperature: 0.2 });
    expect(sentBody(provider)).toMatchObject({ messages: withImage, temperature: 0.2 });
  });

  it.each([
    [{ maxOutputTokens: Number.NaN }],
    [{ maxOutputTokens: 0 }],
    [{ maxOutputTokens: -1 }],
    [{ maxOutputTokens: 1.5 }],
    [{ maxOutputTokens: 100, temperature: 3 }],
    [{ maxOutputTokens: 100, temperature: Number.NaN }],
    [{ maxOutputTokens: 100, timeoutMs: 0 }],
  ])("rejects invalid options %o as a config error, without a call", async (options) => {
    const provider = fakeProvider();
    const error = await caught(createLlmClient(config, provider.deps).chat(messages, options));
    expect(error.kind).toBe("config");
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("lowers max_tokens to what the budget allows", async () => {
    const provider = fakeProvider(completion("ok", { total_tokens: 50 }));
    const client = createLlmClient({ ...config, maxTokensPerRun: 500 }, provider.deps);
    await client.chat(messages, { maxOutputTokens: 4000 });
    expect(sentBody(provider).max_tokens).toBe(500 - PROMPT);
  });

  it("refuses a call that cannot fit, without contacting the provider", async () => {
    const provider = fakeProvider();
    const client = createLlmClient({ ...config, maxTokensPerRun: 10 }, provider.deps);
    const error = await caught(client.chat(messages, opts));
    expect(error.kind).toBe("cap_exceeded");
    expect(isTokenCapExceeded(error)).toBe(true);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("holds the budget for calls in flight, so overlapping calls can't overspend", async () => {
    const provider = fakeProvider(
      completion("a", { total_tokens: 50 }),
      completion("b", { total_tokens: 50 }),
    );
    const client = createLlmClient({ ...config, maxTokensPerRun: 300 }, provider.deps);
    const results = await Promise.allSettled([
      client.chat(messages, { maxOutputTokens: 200 }),
      client.chat(messages, { maxOutputTokens: 200 }),
      client.chat(messages, { maxOutputTokens: 200 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect(sentBody(provider, 0).max_tokens).toBe(200);
    expect(sentBody(provider, 1).max_tokens).toBe(300 - (PROMPT + 200) - PROMPT);
    expect(client.tokensUsed).toBe(100);
  });

  it("stops the run once reported usage passes the cap", async () => {
    const provider = fakeProvider(
      completion("first", { total_tokens: 600 }),
      completion("second", { prompt_tokens: 300, completion_tokens: 200 }),
    );
    const client = createLlmClient({ ...config, maxTokensPerRun: 1000 }, provider.deps);
    await client.chat(messages, opts);
    const error = await caught(client.chat(messages, opts));
    expect(error.kind).toBe("cap_exceeded");
    expect(client.tokensUsed).toBe(1100);
    // Later calls are refused up front.
    expect((await caught(client.chat(messages, opts))).kind).toBe("cap_exceeded");
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("allows usage exactly at the cap, then refuses the next call", async () => {
    const provider = fakeProvider(completion("ok", { total_tokens: 1000 }));
    const client = createLlmClient({ ...config, maxTokensPerRun: 1000 }, provider.deps);
    expect((await client.chat(messages, opts)).text).toBe("ok");
    expect((await caught(client.chat(messages, opts))).kind).toBe("cap_exceeded");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("counts the worst case when usage is missing, and never less than the prompt", async () => {
    const provider = fakeProvider(
      completion("x".repeat(40), null),
      completion("y", { total_tokens: 0 }),
      completion("z", { total_tokens: 1, prompt_tokens: 5, completion_tokens: 7 }),
    );
    const client = createLlmClient(config, provider.deps);
    const missing = await client.chat(messages, opts);
    expect(missing).toMatchObject({ estimated: true, tokens: PROMPT + 100 });
    expect((await client.chat(messages, opts)).tokens).toBe(PROMPT + 100);
    expect((await client.chat(messages, opts)).tokens).toBe(Math.max(12, PROMPT));
  });

  it("reports a cut-off reply through finishReason", async () => {
    const provider = fakeProvider(completion("partial", { total_tokens: 10 }, "length"));
    const result = await createLlmClient(config, provider.deps).chat(messages, opts);
    expect(result.finishReason).toBe("length");
  });

  it("retries rate limits and server errors, honouring Retry-After and logging only numbers", async () => {
    const provider = fakeProvider(
      new Response("busy", { status: 429, headers: { "retry-after": "7" } }),
      new Response("oops", { status: 503 }),
      completion("done"),
    );
    const result = await createLlmClient(config, provider.deps).chat(messages, opts);
    expect(result.text).toBe("done");
    expect(provider.sleep.mock.calls.map(([ms]) => ms)).toEqual([7000, 4000]);
    expect(provider.log.mock.calls).toEqual([
      ["llm.retry", { attempt: 1, status: 429, delayMs: 7000 }],
      ["llm.retry", { attempt: 2, status: 503, delayMs: 4000 }],
    ]);
  });

  it("gives up at once when Retry-After is longer than it is worth waiting", async () => {
    const provider = fakeProvider(
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    );
    const client = createLlmClient(config, provider.deps);
    expect((await caught(client.chat(messages, opts))).kind).toBe("rate_limited");
    expect(provider.sleep).not.toHaveBeenCalled();
    expect(client.tokensUsed).toBe(0);
  });

  it.each([
    [429, "rate_limited"],
    [503, "provider"],
  ])("gives up after three %i replies, counting nothing", async (status, kind) => {
    const provider = fakeProvider(
      new Response("", { status }),
      new Response("", { status }),
      new Response("", { status }),
    );
    const client = createLlmClient(config, provider.deps);
    expect((await caught(client.chat(messages, opts))).kind).toBe(kind);
    expect(provider.fetch).toHaveBeenCalledTimes(3);
    expect(client.tokensUsed).toBe(0);
  });

  it.each([
    [401, "auth", "LLM_API_KEY"],
    [402, "provider", "402"],
    [404, "provider", "LLM_MODEL"],
    [400, "provider", "supports it"],
  ])("maps status %i to a %s error without retrying", async (status, kind, hint) => {
    const provider = fakeProvider(
      Response.json({ error: { message: "echoed prompt text" } }, { status }),
    );
    const client = createLlmClient(config, provider.deps);
    const error = await caught(client.chat(messages, opts));
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(hint);
    expect(error.message).not.toContain("echoed prompt text");
    expect(error.message).not.toContain(KEY);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(client.tokensUsed).toBe(0);
  });

  it("doesn't retry network failures, counts them in full, and never echoes fetch's error", async () => {
    const provider = fakeProvider(
      new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value.`),
    );
    const client = createLlmClient(config, provider.deps);
    const error = await caught(client.chat(messages, opts));
    expect(error.message).toBe("LLM request failed");
    expect(error.cause).toBeUndefined();
    expect(String(error.stack)).not.toContain(KEY);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(client.tokensUsed).toBe(PROMPT + 100);
  });

  it("treats a timeout while sending or reading as a timeout, counted in full", async () => {
    const timeout = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const slowBody = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(timeout());
        },
      }),
    );
    const provider = fakeProvider(timeout(), slowBody);
    const client = createLlmClient(config, provider.deps);
    expect((await caught(client.chat(messages, opts))).message).toBe("LLM request timed out");
    expect((await caught(client.chat(messages, opts))).message).toBe("LLM request timed out");
    expect(client.tokensUsed).toBe(2 * (PROMPT + 100));
  });

  it("rejects unusable replies, still counting their tokens", async () => {
    const provider = fakeProvider(
      completion(null, { total_tokens: 30 }, "length"),
      new Response("not json", { status: 200 }),
    );
    const client = createLlmClient(config, provider.deps);
    const noText = await caught(client.chat(messages, opts));
    expect(noText.kind).toBe("bad_response");
    expect(noText.message).toContain("finish: length");
    expect(client.tokensUsed).toBe(30);
    const notJson = await caught(client.chat(messages, opts));
    expect(notJson.message).toBe("LLM reply was not JSON");
    expect(client.tokensUsed).toBe(30 + PROMPT + 100);
  });
});
