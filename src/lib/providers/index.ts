import { getEnv } from "@/lib/env";
import {
  OpenAIGenerationProvider,
  OpenAIResponsesClient,
  OpenAIValidationProvider,
  type ReasoningEffort,
} from "./openai";
import { MockGenerationProvider } from "./mock/generator";
import { MockSearchProvider } from "./mock/search";
import { MockValidationProvider } from "./mock/validator";
import {
  NotConfiguredGeneration,
  NotConfiguredSearch,
  NotConfiguredValidation,
} from "./not-configured";
import type { ProviderSet } from "./types";

export interface ProviderCredentials {
  openaiApiKey?: string;
  /** Defaults come from the environment when omitted. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  baseUrl?: string;
}

/**
 * Builds the provider set for a runtime mode. Live mode with an OpenAI key
 * yields the OpenAI generation and validation adapters; search arrives in
 * Phase 3. Without a key everything is "not configured": nothing pretends
 * to be live.
 */
export function createProviders(
  mode: "mock" | "live",
  credentials: ProviderCredentials = {},
): ProviderSet {
  if (mode === "mock") {
    return {
      mode,
      generation: new MockGenerationProvider(),
      validation: new MockValidationProvider(),
      search: new MockSearchProvider(),
    };
  }
  if (credentials.openaiApiKey) {
    const env = getEnv();
    const options = {
      client: new OpenAIResponsesClient({
        apiKey: credentials.openaiApiKey,
        baseUrl: credentials.baseUrl ?? env.AGORA_OPENAI_BASE_URL,
      }),
      model: credentials.model ?? env.AGORA_OPENAI_MODEL,
      effort: credentials.reasoningEffort ?? env.AGORA_OPENAI_REASONING_EFFORT,
    };
    return {
      mode,
      generation: new OpenAIGenerationProvider(options),
      validation: new OpenAIValidationProvider(options),
      search: new NotConfiguredSearch(),
    };
  }
  return {
    mode,
    generation: new NotConfiguredGeneration(),
    validation: new NotConfiguredValidation(),
    search: new NotConfiguredSearch(),
  };
}

export function describeProviders(providers: ProviderSet): {
  mode: "mock" | "live";
  generation: { name: string; configured: boolean };
  validation: { name: string; configured: boolean };
  search: { name: string; configured: boolean };
} {
  return {
    mode: providers.mode,
    generation: {
      name: providers.generation.name,
      configured: providers.generation.configured,
    },
    validation: {
      name: providers.validation.name,
      configured: providers.validation.configured,
    },
    search: { name: providers.search.name, configured: providers.search.configured },
  };
}

export * from "./types";
