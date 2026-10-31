import { ProviderCallError, type Usage } from "../types";

/**
 * Minimal Responses API client over fetch. It maps every failure to a
 * ProviderCallError that says whether the call was billed and may be retried.
 * The API key is only ever placed in the Authorization header.
 */

export interface ParsedResponse {
  /** Concatenated output_text of all message outputs. */
  text: string;
  usage: Usage;
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

interface ContentItem {
  type?: string;
  text?: string;
  refusal?: string;
}

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string | null; message?: string } | null;
  output?: { type?: string; content?: ContentItem[] }[];
  usage?: ResponsesUsage | null;
}

const NETWORK_NOT_BILLED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export function mapUsage(usage: ResponsesUsage): Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    // output_tokens already includes reasoning tokens.
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    estimatedCostUsd: 0,
  };
}

function causeCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name =
    typeof error === "object" && error !== null ? (error as { name?: string }).name : "";
  return name === "AbortError" || name === "TimeoutError";
}

export class OpenAIResponsesClient {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpenAIClientOptions) {
    this.apiKey = opts.apiKey;
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/responses`;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async create(body: object, signal?: AbortSignal): Promise<ParsedResponse> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error, signal)) {
        throw new ProviderCallError(
          "The provider call timed out or was aborted.",
          "ambiguous",
          true,
          { code: "timeout" },
        );
      }
      const code = causeCode(error);
      if (code && NETWORK_NOT_BILLED.has(code)) {
        throw new ProviderCallError(
          `Could not reach the provider (${code}).`,
          "not_billed",
          true,
          {
            code: "network",
          },
        );
      }
      throw new ProviderCallError("The connection to the provider failed.", "ambiguous", true, {
        code: "network",
      });
    }

    if (!response.ok) throw await this.httpError(response);

    let parsed: ResponsesBody;
    try {
      parsed = (await response.json()) as ResponsesBody;
    } catch {
      // Accepted but unreadable: the outcome is unknown.
      throw new ProviderCallError(
        "The provider response was not valid JSON.",
        "ambiguous",
        false,
        {
          status: response.status,
          code: "unreadable_response",
        },
      );
    }
    return this.interpret(parsed);
  }

  private async httpError(response: Response): Promise<ProviderCallError> {
    const status = response.status;
    let detail = "";
    let code: string | undefined;
    try {
      const json = (await response.json()) as { error?: { message?: string; code?: string } };
      detail = json.error?.message ? `: ${json.error.message.slice(0, 200)}` : "";
      code = json.error?.code ?? undefined;
    } catch {
      // Non-JSON error body; the status is enough.
    }
    // Defensive: never let the key travel into an error message.
    detail = detail.split(this.apiKey).join("[redacted]");

    if (status === 401 || status === 403) {
      return new ProviderCallError(
        `OpenAI rejected the credentials: the key is invalid or lacks access (HTTP ${status}).`,
        "not_billed",
        false,
        { status, code: "auth" },
      );
    }
    if (status === 429) {
      return new ProviderCallError(
        `OpenAI rate limit or quota (HTTP 429)${detail}`,
        "not_billed",
        true,
        { status, code: "rate_limited" },
      );
    }
    if (status === 408 || status === 409 || status >= 500) {
      return new ProviderCallError(
        `OpenAI temporary failure (HTTP ${status})${detail}`,
        "not_billed",
        true,
        { status, code: code ?? "temporary" },
      );
    }
    return new ProviderCallError(
      `OpenAI rejected the request (HTTP ${status})${detail}`,
      "not_billed",
      false,
      { status, code: code ?? "bad_request" },
    );
  }

  private interpret(body: ResponsesBody): ParsedResponse {
    const usage = body.usage ? mapUsage(body.usage) : undefined;
    const status = body.status ?? "completed";

    if (status === "incomplete") {
      const reason = body.incomplete_details?.reason ?? "unknown";
      throw new ProviderCallError(
        `The model response was incomplete (${reason}).`,
        usage ? "billed" : "ambiguous",
        false,
        { code: `incomplete:${reason}`, usage },
      );
    }
    if (status === "failed" || status === "cancelled") {
      const why = body.error?.message ? `: ${body.error.message.slice(0, 200)}` : "";
      throw new ProviderCallError(
        `The model response ${status}${why}.`,
        usage ? "billed" : "ambiguous",
        false,
        { code: body.error?.code ?? status, usage },
      );
    }
    if (!usage) {
      throw new ProviderCallError(
        "The provider response carried no usage.",
        "ambiguous",
        false,
        {
          code: "missing_usage",
        },
      );
    }

    let text = "";
    for (const item of body.output ?? []) {
      if (item.type !== "message") continue;
      for (const content of item.content ?? []) {
        if (content.type === "refusal") {
          throw new ProviderCallError("The model refused the request.", "billed", false, {
            code: "refusal",
            usage,
          });
        }
        if (content.type === "output_text" && typeof content.text === "string") {
          text += content.text;
        }
      }
    }
    return { text, usage };
  }
}
