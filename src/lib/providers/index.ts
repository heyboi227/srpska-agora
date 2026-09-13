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
}

/**
 * Builds the provider set for a runtime mode. Live adapters arrive in Phase 2;
 * until then, live mode with or without credentials yields "not configured"
 * providers, which is the honest state: nothing pretends to be live.
 */
export function createProviders(
  mode: "mock" | "live",
  _credentials: ProviderCredentials = {},
): ProviderSet {
  if (mode === "mock") {
    return {
      mode,
      generation: new MockGenerationProvider(),
      validation: new MockValidationProvider(),
      search: new MockSearchProvider(),
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
