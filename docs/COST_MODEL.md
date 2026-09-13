# Cost model

Prices below were verified in the project brief on 2026-09-12 and are dated reference points. Re-check every rate at checkout time and before enabling live mode. Nothing here is a promise about an invoice; the application limit stops new paid work based on conservative accounting.

## Budget frame

The owner selected EUR 15–30 per month for the complete running cost, excluding development. Within that, metered AI and search spend is capped at USD 15 per month (standard preset) or USD 7 (quiet preset). The AI cap is inside the total, not on top of it.

Currencies are kept explicit: hosting is quoted in EUR, metered usage in USD. Convert with a dated rate before adding them.

## Rates (verified 2026-09-12)

| Item                                 | Rate                                                        | Source                                                                             |
| ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GPT-5.6 Luna, standard short context | USD 0.20 per 1M input tokens, USD 1.20 per 1M output tokens | https://developers.openai.com/api/docs/models/gpt-5.6-luna                         |
| OpenAI web search tool               | USD 10 per 1,000 calls plus returned content at model rates | https://developers.openai.com/api/docs/pricing                                     |
| Hetzner CX23 (2 vCPU, 4 GB, 40 GB)   | EUR 5.49/month before VAT, availability not guaranteed      | https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ |
| Hetzner primary IPv4                 | EUR 0.50/month                                              | https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/     |
| Hetzner server backups               | 20% of the server price                                     | https://docs.hetzner.com/cloud/billing/faq/                                        |
| Cloudflare R2 Standard               | 10 GB-month free, then USD 0.015/GB-month                   | https://developers.cloudflare.com/r2/pricing/                                      |

The model has not been evaluated for Serbian quality; the rate is a price example only.

## Formula

```text
monthly_model_cost =
  days × calls_per_day ×
  ((average_input_tokens × input_rate_per_million
    + average_billed_output_tokens × output_rate_per_million) / 1,000,000)

monthly_search_tool_cost =
  days × actual_search_calls_per_day × price_per_search_call

monthly_running_cost =
  hosting + model_cost + search_tool_cost + backups + domain + applicable_taxes
```

Assumptions for the examples: every model call (generation, validation, repairs, research synthesis) averages 2,000 uncached input tokens and 500 billed output tokens including reasoning; no caching discount; 30 days.

## Workload examples

| Workload        | Content actions/day | Model calls/day | Paid searches/day | Model USD/month | Search USD/month | Variable subtotal |
| --------------- | ------------------: | --------------: | ----------------: | --------------: | ---------------: | ----------------: |
| Quiet preset    |            about 60 |             140 |                 4 |            4.20 |             1.20 |              5.40 |
| Standard preset |           up to 150 |             350 |                 8 |           10.50 |             2.40 |             12.90 |
| Busier (future) |           about 600 |           1,400 |                16 |           42.00 |             4.80 |             46.80 |

Model cost per call at the assumed averages: (2,000 × 0.20 + 500 × 1.20) / 1,000,000 = USD 0.001. The busier row is for comparison and does not fit the selected budget; it is not a preset.

Infrastructure allowance: about EUR 8–12 per month for a small EU VPS with IPv4 and provider backups, conditional on an economical plan being orderable. Domain renewal and off-server backup storage are separate; R2's free allowance covers the planned 10 GiB backup cap at zero cost while usage stays inside it.

Consolidated example for the standard preset, before taxes and conversion detail: EUR 7.09 hosting + USD 12.90 metered. At any plausible EUR/USD rate this lands in the lower half of the EUR 15–30 frame; the owner recalculates with taxes, a dated rate, and domain amortisation before choosing a preset.

## The decision that matters most: shared research

Sixteen personas searching hourly would be 11,520 searches a month, USD 115.20 in tool fees alone. Eight shared searches a day cost USD 2.40. Research is therefore one shared service whose results all personas consume.

## Caps as configured

| Preset   | Daily variable cap | Monthly variable cap | Paid searches/day | Generation output cap | Validation output cap |
| -------- | -----------------: | -------------------: | ----------------: | --------------------: | --------------------: |
| standard |           USD 0.50 |            USD 15.00 |                 8 |            800 tokens |            300 tokens |
| quiet    |           USD 0.23 |             USD 7.00 |                 4 |            800 tokens |            300 tokens |

Both windows apply; the lower remaining allowance wins.

## Budget rules (Phase 2 implementation)

1. All paid calls go through one cost gateway.
2. A conservative upper-bound cost is reserved in a database transaction before dispatch.
3. Outstanding reservations count against daily and monthly limits across all workers.
4. Generation, validation, repairs, search calls, returned search context, and retries all count.
5. Actual usage is reconciled after completion; ambiguous timeouts keep their reservation until reconciled.
6. Calls that cannot fit the remaining budget, or have no usable price estimate, are rejected.
7. The model is never escalated to a more expensive one automatically.
8. Degradation is staged: fewer low-value topics, less routine commentary, a few sourced updates, then a full pause of paid work. Reading continues.

## Measurement

Phase 1 spends nothing: mock mode makes no external calls and records zero usage. Once live, the application stores per-request usage and estimated cost (`provider_requests`, Phase 2) and the administrator sees actual and reserved spend, remaining allowance, and a forecast. Observed Serbian token averages replace the assumptions above; Serbian text in Cyrillic tends to tokenise less efficiently than English, so the 2,000/500 averages must be validated rather than trusted.

## Local operation and electricity

If an always-on machine already exists, local hosting can be economical; measure its added draw. Illustrative arithmetic at an assumed EUR 0.20/kWh: 25 W average for 30 days is 18 kWh, EUR 3.60; 100 W is 72 kWh, EUR 14.40. These are examples, not Serbian tariffs. Local inference needs its own benchmark of Serbian quality, memory, speed, and licensing before it replaces the cloud API; a 4 GB application server cannot also run a useful local model.
