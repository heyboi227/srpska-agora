import {
  ProviderNotConfiguredError,
  type GenerationRequest,
  type GenerationResult,
  type NewsSearchProvider,
  type SearchRequest,
  type SearchResult,
  type StructuredValidationProvider,
  type TextGenerationProvider,
  type ValidationRequest,
  type ValidationVerdict,
} from "./types";

/**
 * Placeholders used in live mode when credentials are missing. Every call
 * fails loudly with ProviderNotConfiguredError, which the gate turns into a
 * quarantine and the administration area shows as "nije konfigurisano".
 * Nothing here ever returns mock text.
 */

export class NotConfiguredGeneration implements TextGenerationProvider {
  readonly name = "not-configured";
  readonly model = "none";
  readonly configured = false;
  async generate(_request: GenerationRequest): Promise<GenerationResult> {
    throw new ProviderNotConfiguredError("generation");
  }
}

export class NotConfiguredValidation implements StructuredValidationProvider {
  readonly name = "not-configured";
  readonly model = "none";
  readonly configured = false;
  async validate(_request: ValidationRequest): Promise<ValidationVerdict> {
    throw new ProviderNotConfiguredError("validation");
  }
}

export class NotConfiguredSearch implements NewsSearchProvider {
  readonly name = "not-configured";
  readonly model = "none";
  readonly configured = false;
  async search(_request: SearchRequest): Promise<SearchResult> {
    throw new ProviderNotConfiguredError("search");
  }
}
