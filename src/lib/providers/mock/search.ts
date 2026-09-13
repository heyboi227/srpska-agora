import {
  ZERO_USAGE,
  type NewsSearchProvider,
  type SearchRequest,
  type SearchResult,
} from "../types";

/**
 * Mock search returns nothing. Returning fabricated "news" from a mock would be
 * exactly the failure this project must never have: invented current events.
 * Fixture articles are seeded explicitly and labelled as fixtures instead.
 */
export class MockSearchProvider implements NewsSearchProvider {
  readonly name = "mock";
  readonly configured = true;

  async search(_request: SearchRequest): Promise<SearchResult> {
    return { items: [], billableCalls: 0, usage: ZERO_USAGE, provider: this.name };
  }
}
