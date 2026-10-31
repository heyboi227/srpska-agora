import type { ProviderSet } from "@/lib/providers/types";
import type { CallOrigin, CostGateway } from "./gateway";

/**
 * Wraps every provider capability so each call goes through the cost gateway.
 * The wrappers keep the inner name, model and configured flag, and hand the
 * gateway's signal (not the caller's) to the inner provider. A provider that
 * is not configured is called directly: it makes no paid call, so it must
 * surface ProviderNotConfiguredError rather than a gateway refusal or a
 * rejected request row.
 */
export function meterProviders(
  providers: ProviderSet,
  gateway: CostGateway,
  origin: CallOrigin,
): ProviderSet {
  const { generation, validation, search } = providers;
  return {
    mode: providers.mode,
    generation: {
      name: generation.name,
      model: generation.model,
      configured: generation.configured,
      generate: (request) =>
        generation.configured === false
          ? generation.generate(request)
          : gateway.run(
              {
                actionKey: request.seed,
                purpose: request.repair ? "repair" : "generation",
                origin,
                provider: generation.name,
                model: generation.model,
                estimatePayload: request,
                maxOutputTokens: request.maxOutputTokens,
              },
              (signal) => generation.generate(request, signal),
            ),
    },
    validation: {
      name: validation.name,
      model: validation.model,
      configured: validation.configured,
      validate: (request) =>
        validation.configured === false
          ? validation.validate(request)
          : gateway.run(
              {
                actionKey: request.seed,
                purpose: "validation",
                origin,
                provider: validation.name,
                model: validation.model,
                estimatePayload: request,
                maxOutputTokens: request.maxOutputTokens,
              },
              (signal) => validation.validate(request, signal),
            ),
    },
    search: {
      name: search.name,
      model: search.model,
      configured: search.configured,
      search: (request) =>
        search.configured === false
          ? search.search(request)
          : gateway.run(
              {
                actionKey: request.seed,
                purpose: "search",
                origin,
                provider: search.name,
                model: search.model,
                estimatePayload: request,
                maxOutputTokens: 0,
              },
              (signal) => search.search(request, signal),
            ),
    },
  };
}
