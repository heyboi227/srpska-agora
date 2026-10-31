import {
  ProviderCallError,
  type GenerationRequest,
  type GenerationResult,
  type StructuredValidationProvider,
  type TextGenerationProvider,
  type Usage,
  type ValidationRequest,
  type ValidationVerdict,
} from "../types";
import type { OpenAIResponsesClient } from "./client";
import { buildGenerationPrompt, buildValidationPrompt } from "./prompts";
import {
  generationJsonSchema,
  generationOutputSchema,
  validationJsonSchema,
  validationOutputSchema,
} from "./schemas";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIProviderOptions {
  client: OpenAIResponsesClient;
  model: string;
  effort: ReasoningEffort;
}

function requestBody(
  opts: OpenAIProviderOptions,
  prompt: { instructions: string; input: string },
  maxOutputTokens: number,
  name: string,
  schema: object,
): object {
  // No temperature: reasoning models may reject it and the docs do not list it for Luna.
  return {
    model: opts.model,
    instructions: prompt.instructions,
    input: prompt.input,
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: opts.effort },
    store: false,
    text: { format: { type: "json_schema", name, schema, strict: true } },
  };
}

function parseJson<T>(
  text: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  usage: Usage,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed("not valid JSON", usage);
  }
  const result = parse(value);
  if (!result.success) throw malformed("did not match the schema", usage);
  return result.data;
}

function malformed(why: string, usage: Usage): ProviderCallError {
  return new ProviderCallError(`The model output ${why}.`, "billed", false, {
    code: "malformed_output",
    usage,
  });
}

export class OpenAIGenerationProvider implements TextGenerationProvider {
  readonly name = "openai";
  readonly configured = true;
  readonly model: string;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.model = opts.model;
  }

  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult> {
    const body = requestBody(
      this.opts,
      buildGenerationPrompt(request),
      request.maxOutputTokens,
      "agora_generation",
      generationJsonSchema,
    );
    const { text, usage } = await this.opts.client.create(body, signal);
    const out = parseJson(text, (v) => generationOutputSchema.safeParse(v), usage);

    const title = out.title?.trim();
    const memoryNote = out.memoryNote?.trim().slice(0, 200).trim();
    return {
      ...(request.purpose === "thread" && title ? { title } : {}),
      body: out.body.trim(),
      script: out.script,
      evidenceIds: out.evidenceIds.map((id) => id.trim()).filter(Boolean),
      ...(memoryNote ? { memoryNote } : {}),
      usage,
      provider: "openai",
      model: this.model,
    };
  }
}

export class OpenAIValidationProvider implements StructuredValidationProvider {
  readonly name = "openai";
  readonly configured = true;
  readonly model: string;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.model = opts.model;
  }

  async validate(request: ValidationRequest, signal?: AbortSignal): Promise<ValidationVerdict> {
    const body = requestBody(
      this.opts,
      buildValidationPrompt(request),
      request.maxOutputTokens,
      "agora_validation",
      validationJsonSchema,
    );
    const { text, usage } = await this.opts.client.create(body, signal);
    const out = parseJson(text, (v) => validationOutputSchema.safeParse(v), usage);
    return {
      verdict: out.verdict,
      languageOk: out.languageOk,
      topicalOk: out.topicalOk,
      evidenceOk: out.evidenceOk,
      moderationOk: out.moderationOk,
      reasons: [...out.reasons],
      explanation: out.explanation.trim(),
      usage,
      provider: "openai",
      model: this.model,
    };
  }
}
