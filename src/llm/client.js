// LLM client, ported from death-star-audit (src/analysis/llm.js): the same env vars, the same two APIs.
//   LLM_API=anthropic  the Messages API (Anthropic, or a gateway speaking it) via @anthropic-ai/sdk
//   LLM_API=openai     an OpenAI-compatible /chat/completions server (LM Studio, llama.cpp, vLLM, ...)
// Both return JSON constrained by a schema.

export function llmStatus(llm) {
  return { enabled: llm.enabled, api: llm.api, model: llm.model, baseURL: llm.baseURL || (llm.api === "anthropic" ? "https://api.anthropic.com" : "") };
}

const CONNECT_CODES = {
  ECONNREFUSED: "refused",
  EHOSTUNREACH: "silent", ENETUNREACH: "silent", ETIMEDOUT: "silent", UND_ERR_CONNECT_TIMEOUT: "silent",
  ENOTFOUND: "unknown", EAI_AGAIN: "unknown",
};

/** Says which of "host off", "LLM server not running" and "wrong address" a failed call was. */
export function explainLlmError(err, llm) {
  let e = err, code;
  for (let i = 0; e && i < 4 && !code; i++, e = e.cause) code = CONNECT_CODES[e.code] && e.code;
  const url = llm.baseURL || "https://api.anthropic.com";
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new Error(`No answer from ${url} within ${Math.round(llm.timeoutMs / 1000)} s. The model may still be loading (LLM_TIMEOUT_SECONDS).`);
  }
  switch (CONNECT_CODES[code]) {
    case "refused":
      return new Error(`${host} is up, but nothing is listening there (${code}): the LLM server is not running.`);
    case "silent":
      return new Error(`${host} did not answer (${code}): the machine looks switched off or off the network.`);
    case "unknown":
      return new Error(`${host} could not be resolved (${code}): check LLM_BASE_URL.`);
    default:
      return err;
  }
}

async function callOpenAiCompatible(llm, { system, user, schema, schemaName }) {
  if (!llm.baseURL) throw new Error("LLM_API=openai needs LLM_BASE_URL (for LM Studio: http://<host>:1234/v1).");
  const url = llm.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}) },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: llm.maxTokens,
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      // The schema goes in the prompt as well: LM Studio uses response_format only to constrain
      // sampling and never shows it to the model (see death-star-audit).
      messages: [
        { role: "system", content: `${system}\n\nAnswer with one JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}` },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(llm.timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try { detail = JSON.parse(body).error?.message || JSON.parse(body).error || detail; } catch { /* not JSON */ }
    throw new Error(`${url} answered ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` +
      (res.status === 404 || /model/i.test(String(detail)) ? ` (is "${llm.model}" available on that server? LLM_MODEL)` : ""));
  }
  const data = JSON.parse(body);
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error(`The response was cut off at ${llm.maxTokens} tokens (LLM_MAX_TOKENS).`);
  const text = choice?.message?.content || "";
  if (!text.trim()) throw new Error("The model returned no answer.");
  return { text, model: data.model };
}

async function callAnthropic(llm, { system, user, schema }) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new Error("The Anthropic SDK is not installed. Run `npm install` first (or use LLM_API=openai).");
  }
  const client = new Anthropic({ apiKey: llm.apiKey, baseURL: llm.baseURL, timeout: llm.timeoutMs });
  const response = await client.beta.messages.create({
    model: llm.model,
    max_tokens: llm.maxTokens,
    // Server-side fallback: if the model declines, the API retries on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: llm.effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined the request.");
  if (response.stop_reason === "max_tokens") throw new Error("The response was cut off (max_tokens).");
  return { text: response.content.filter((b) => b.type === "text").map((b) => b.text).join(""), model: response.model };
}

/** Calls the configured LLM and returns { data, model } with data parsed from the JSON answer. */
export async function askJson(llm, request) {
  if (!llm.enabled) throw new Error("The LLM is not configured. Set LLM_ENABLED=true (see .env.example).");
  if (!["anthropic", "openai"].includes(llm.api)) throw new Error(`Unknown LLM_API "${llm.api}". Supported: anthropic, openai`);
  let answer;
  try {
    answer = llm.api === "openai" ? await callOpenAiCompatible(llm, request) : await callAnthropic(llm, request);
  } catch (err) {
    throw explainLlmError(err, llm);
  }
  try {
    return { data: JSON.parse(answer.text), model: answer.model || llm.model };
  } catch {
    throw new Error(`The model's answer is not JSON (${answer.text.slice(0, 120)}…). With LM Studio, use LLM_API=openai, which enforces the schema.`);
  }
}
