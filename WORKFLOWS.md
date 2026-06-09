# Part Scraper Workflows

## Purpose

This file preserves the standing operating workflow for the Part Scraper app so the process does not depend on chat history.

The app is designed for production support cases where a part is end-of-life, unavailable, or otherwise needs a substitute recommendation.

## Primary Workflow

1. User: Production sends you an email requesting substitute parts for one or more impacted items.
2. User: Clip the relevant portion of the email, including part numbers, descriptions, and any product-use context.
3. User: Paste that clip into the Part Scraper app or into chat when the app tools are available.
4. GPT/App: Run `parts.analyze_clip` to extract likely source part numbers and cache DigiKey lookup data.
5. GPT/App: For each source part, load cached data first.
6. GPT/App: If the source part is missing or stale in the database, query DigiKey and save the result locally.
7. GPT/App: Auto-discover likely substitute candidates by DigiKey search and other web research as needed. Do not limit discovery to the original manufacturer or the current part family. Intentionally search for compatible parts from other manufacturers when they appear to be plausible drop-in or near drop-in substitutes, then write the discovered candidates and supporting lookup data into the local database.
8. GPT/App: For the source part and each candidate part, call `getTechnicalParametersForPartNumber(partNumber)` or `parts.technical_parameters`.
9. GPT/App: Exclude parts with lifecycle states such as `Obsolete` or `Not Recommended for New Designs` from substitute consideration. Keep them in the database for traceability, but do not present them as viable recommended candidates for new work unless the user explicitly asks to include them for review.
10. GPT/App: Use `compareTechnicalParameters(...)` or `parts.compare_parts` only for direct one-source-to-one-candidate comparison when a single candidate needs to be evaluated in detail.
11. GPT/App: Use `rankSubstituteCandidates(...)` or `parts.rank_substitutes` as the default workflow for evaluating multiple discovered candidates and ordering them by fit.
12. GPT/App: For each source part scraped from the email, print a side-by-side comparison table in chat. Put the original email part number in the left-most column and the ranked candidate substitutes in the columns to the right. Add rows underneath for the important comparison details, including `Category`, `Score`, `Reasons`, `Review notes`, `stock`, `status`, and then the key technical parameters below `status`, followed by `package` and other relevant technical summary fields. Order candidate columns from best-ranked to lowest-ranked.
13. GPT/App: Repeat Step 12 for each source part scraped from the email so the full pasted clip produces a complete per-part substitute summary in chat.
14. GPT/App: Keep all looked-up data, raw responses, discovered candidates, and analysis results in the local SQLite database.

## Current Tools

- `parts.analyze_clip`
  - Extracts likely part numbers from pasted text.
  - Looks up DigiKey match, stock, status, price, and candidate substitutes.
  - Stores normalized and raw results in SQLite.

- `parts.cache_summary`
  - Reports local cache record counts and last update time.

- `parts.technical_parameters`
  - Returns stored technical parameters for a part number.
  - Queries DigiKey automatically if the part is missing or stale.
  - Returns a reason if technical parameters are unavailable.

- `parts.compare_parts`
  - Compares one source part to one candidate part.
  - Uses technical parameters plus lifecycle, stock, and price context.
  - Returns a score, category, reasons, and review notes.
  - Best used for one-off detailed review of a single candidate.

- `parts.rank_substitutes`
  - Ranks multiple candidate substitutes for a source part.
  - Should be the default workflow after source part extraction.
  - Auto-discovers candidates when they are not already supplied, including plausible cross-manufacturer substitutes.
  - Returns all ranked candidates with the top candidate highlighted, plus score, category, reasons, and review notes.
  - The chat response should present the ranked results for each scraped source part in a side-by-side comparison table, with the source part in the left-most column and candidate substitutes arranged to the right from best-ranked to lowest-ranked.

## Technical Parameter Ranking Rules

Current ranking logic gives weight to:

- package / case
- supplier device package
- reverse voltage
- capacitance
- capacitance ratio
- diode type
- operating temperature
- lifecycle status
- stock availability
- price

Current result categories:

- `Recommended`
- `Possible with review`
- `Poor match`

## Cache Rules

- Use the local SQLite cache first before making new DigiKey requests.
- Cache looked-up part records in `part-cache.sqlite`.
- Cache clip analysis snapshots in the same database.
- Store both normalized fields and raw DigiKey response payloads.
- Treat stale records as eligible for refresh.

## Logging Rules

- Always append debug output to `debug.log`.
- Log clip analysis starts and completions.
- Log DigiKey search, detail, and pricing request/response payloads.
- Log technical-parameter lookups and substitute ranking summaries.

## Expected Failure Reasons

When a lookup or comparison cannot complete fully, return a clear reason instead of failing silently.

Examples:

- `Part number is empty after normalization.`
- `No DigiKey match was found for <part number>.`
- `DigiKey request failed: <error details>`
- `DigiKey matched <part>, but no technical parameters were present in the response.`
- `No substitute candidates were available to rank.`

## Operator Guidance

- Prefer manufacturer part numbers over generic package tokens when evaluating substitutes.
- Treat package mismatch as a strong warning for drop-in replacement claims.
- Treat missing technical parameters as a review condition, not automatic approval.
- Prefer active lifecycle parts with real stock over last-time-buy parts.
- Use the app result as a ranked engineering starting point, not final approval for critical substitutions.
- Assume the normal workflow is source part extraction followed by multi-candidate ranking unless you explicitly ask for one direct part-to-part comparison.
- After ranking, print the substitute summary in chat for every scraped source part instead of keeping the result only inside tool output.
- The preferred chat format is the Step 11 side-by-side comparison table, unless you explicitly ask for a different layout.

## Reference Samples

- Preserve stable sample clips in code or repo files for regression testing.
- The current saved sample is the Skyworks discontinuation email clip hard-coded as `REFERENCE_SAMPLE_CLIP` in [src/widget.html](/C:/Users/Michael/Documents/Web%20Apps/part-scraper-app/src/widget.html).

## Next Improvements

1. Add a candidate-discovery cache so repeated substitute ranking runs are faster.
2. Store comparison and ranking results in SQLite.
3. Add widget actions for technical-parameter lookup, direct compare, and ranked substitutes.
4. Add regression tests using saved real-world sample clips.
