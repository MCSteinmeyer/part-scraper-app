# Part Scraper Changelog

## 2026-06-11

### Changed
- Reworked substitute discovery so the active code path now follows `WORKFLOWS.md` and uses the DigiKey Product Information V4 substitutions endpoint as the primary candidate auto-discovery source.
- Reworked cached lookup normalization so source-part lookups store DigiKey substitution payloads alongside the normalized recommendation list for later ranking runs.
- Generalized technical comparison scoring away from a diode-only path so package, core electrical ratings, functional parameters, interface or logic characteristics, performance characteristics, operating temperature, lifecycle, stock, and price can all contribute under the current workflow rules.
- Updated `WORKFLOWS.md` so the documented default behavior is now explicit: after the initial lookup pass, the full substitution ranking workflow runs for every scraped source part, with obsolete and zero-stock treated as ranking/reporting signals instead of gates that decide whether a part gets ranked.
- Updated substitute scoring so passive components such as capacitors, resistors, ferrite beads, crystals, and similar passive parts now treat exact package match as a much stronger ranking factor, and cross-manufacturer equivalents receive a small boost over same-manufacturer alternates when the rest of the comparison is otherwise similar.
- Tightened passive-component comparison order so exact part value is now the highest-priority technical match, followed by tolerance, package type, material type, temperature coefficient, operating temperature, temperature rating, and other rated limits when those parameters are available from DigiKey.

### Removed
- Removed the retired manufacturer capability scoring and manufacturer search-attempt code paths from `src/server.mjs`.
- Removed the unused SQLite schema initialization for `manufacturer_capability_scores` and `manufacturer_search_attempts` from the active app startup path.

### Fixed
- Fixed live DigiKey request headers so substitution lookups can send the account header when the substitutions endpoint requires the same account-scoped context as detail and pricing calls.
- Added mock substitutions responses so demo-mode workflow and regression runs still exercise the new substitutions-first discovery path instead of silently falling back to the retired strategy logic.

## 2026-06-10

### Added
- Added `Substitution Search Strategy.md` and connected Workflow Step 7 to strategy-driven manufacturer/brand search planning.
- Added manufacturer capability scoring guidance, lifecycle aliases, confidence rules, and search-attempt result classifications.
- Added code helpers for part-type classification, manufacturer reference parsing, manufacturer search planning, search-attempt classification, lifecycle filtering, and manufacturer capability score updates.
- Added SQLite tables for manufacturer capability scores and manufacturer search attempts so substitute discovery can learn which manufacturers are productive for each part type.
- Added a `scripts/run-reference-sample.mjs` regression/debug runner that loads `REFERENCE_SAMPLE_CLIP`, calls the MCP app, and can optionally run substitute ranking for selected parts.
- Added `scripts/inspect-preview-dom.mjs`, a small local Playwright helper that opens the preview page, waits for manual UI interaction, and prints a live DOM summary for debugging.

### Changed
- Moved `Substitution Search Strategy.md` and `semiconductor_and_ic_manufacturers.md` into `cold-storage/legacy-strategy/` so they are no longer part of the active Part Scraper workflow context.
- Updated `WORKFLOWS.md` so Part Scraper Step 7 no longer references `Substitution Search Strategy.md` and instead uses the DigiKey Product Information V4 substitutions endpoint from the `digikey-api` skill as the primary substitute auto-discovery path.
- Updated substitute ranking so Workflow Step 7 now always runs manufacturer-widening discovery, even when the source part already has an active direct DigiKey match or same-manufacturer suggestions.
- Updated manufacturer-widening discovery so the planned manufacturer pass continues for scoring and evidence collection even after the visible candidate list is already full.
- Expanded part-type classification and strategy search phrasing so logic-gate parts such as `SN7400` can participate in the cross-manufacturer discovery workflow.
- Updated substitute output so each suggested replacement explicitly identifies the manufacturer that DigiKey shows as currently making or listing that part, instead of burying the maker only in the metadata line.
- Updated `WORKFLOWS.md` and `Substitution Search Strategy.md` so the documented workflow now requires substitute output to explicitly report who DigiKey shows as the current manufacturer or listing maker for viable candidates.
- Expanded clip parsing to recognize stacked table layouts where each row is spread across multiple lines under headers like `Item`, `Description`, `Impacted Skyworks P/N`, and `Impacted Products`, so the parser prefers the qualified part-number cell and ignores the adjacent description and product cells.
- Updated clip parsing so table-like email snippets are analyzed column-by-column, with the parser preferring headers and values that look like qualified part numbers while avoiding description, product, item, and quantity columns.
- Updated the preview widget with a `Clear Window` button that resets the clip input, status text, and rendered results between email clips.
- Stopped caching source-specific match scores, category explanations, candidate ranking reasons, and review notes as long-term part data because those values only apply when compared to one reference part.
- Refined `Category Explanation` text so `Poor match` reports only the specific evidence found for that candidate, such as zero stock, lifecycle status, package mismatch, incomplete comparison data, or concrete technical review flags.
- Updated the substitute ranking table to include a `Category Explanation` row directly below `Score`, including why `Poor match` candidates should not be treated as strong drop-in substitutes.
- Updated strategy discovery ordering so manufacturer/brand strategy searches run before generic broad fallback candidate searches.
- Updated Step 12 report guidance and substitute ranking text output so the first data row shows `Manufacturer - Part Number` for the source part and each candidate.

### Fixed
- Fixed quick preview substitute validation so candidates that fail DigiKey detail/pricing enrichment are dropped instead of being shown from incomplete lightweight search data.
- Fixed quick preview substitute suggestions so marketplace-style relisted parts, such as Rochester-backed obsolete carryovers, are not shown as default recommended replacements.
- Fixed marketplace carryover detection so nested DigiKey variation records are inspected for marketplace flags, supplier names, and Rochester product URLs before a quick substitute is shown.
- Fixed quick preview substitute suggestions so each candidate is revalidated against its own DigiKey detail-page lifecycle status before it is shown.
- Fixed preview-card substitute suggestions so obsolete and other excluded lifecycle parts are no longer shown as recommended quick replacements.
- Fixed DigiKey price handling so missing or blank pricing no longer renders as fake `$0.00` values for source parts or suggested substitutes.
- Fixed live-mode testing so cached demo-mode records are bypassed instead of being reused as fresh live DigiKey results.
- Tightened substitute categories so candidates with missing critical technical comparisons are capped at `Possible with review` instead of being marked `Recommended`.
- Fixed manufacturer miss counting so multiple query variants for the same source part count as one completed miss for manufacturer capability scoring.

## 2026-06-08

### Added
- Created a new Part Scraper app workspace from the DigiKey project as the starting point.
- Added `parts.analyze_clip` for extracting part numbers from pasted email clips and looking up DigiKey data.
- Added `parts.cache_summary` for checking the local SQLite cache.
- Added `parts.technical_parameters` for returning cached or live DigiKey technical parameters with explicit failure reasons.
- Added `parts.compare_parts` for direct one-source-to-one-candidate technical comparison.
- Added `parts.rank_substitutes` for multi-candidate substitute ranking using technical parameters, status, stock, and price.
- Added a local SQLite cache at `part-cache.sqlite` for looked-up part records and clip analysis snapshots.
- Added append-only `debug.log` tracing for clip analysis, DigiKey requests, technical-parameter lookups, and substitute ranking.
- Added a new widget UI focused on clip paste, part extraction, and substitute recommendations.
- Added a preserved `REFERENCE_SAMPLE_CLIP` in the widget for repeatable live testing with the Skyworks discontinuation sample.
- Removed the Google Drive export flow from the new app setup.
- Added a cleaned `.env.example` for Part Scraper-specific settings.
- Added `WORKFLOWS.md` to document the standing user + GPT/App collaboration workflow.

### Changed
- Renamed the project metadata and documentation from DigiKey BOM quoting to Part Scraper part analysis.
- Switched the local workflow from BOM import/export to email clip parsing and part recommendation lookup.
- Reworked the preview UI to show extracted parts, substitute suggestions, cache stats, and lookup notes.
- Kept DigiKey lookup support for product status, stock level, and price, but redirected it toward substitute recommendations instead of CSV export.
- Expanded the substitute logic from keyword similarity alone to technical-parameter-based comparison and ranking.
- Clarified the long-term workflow documentation so candidate discovery, comparison, ranking, logging, and review expectations are explicit.
- Tightened the source-part parser so tabular clips prefer the `Impacted Skyworks P/N` column and stop promoting generic package or product tokens as primary extracted parts.
- Tightened substitute ranking so package mismatch, obsolete lifecycle state, and zero-stock candidates are pushed down instead of surfacing as top recommendations.
- Updated Step 11 workflow expectations so ranked substitute results are printed directly in chat for each scraped source part.
- Refined the Step 11 chat output format toward side-by-side per-part comparison presentation.
- Expanded the workflow documentation so Step 7 explicitly includes cross-manufacturer substitute discovery instead of limiting searches to the original part family.
- Updated workflow rules to exclude `Obsolete` and `Not Recommended for New Designs` parts from viable substitute consideration unless explicitly requested for review.
- Clarified the workflow table layout so `status` is followed by key technical parameters in the chat output.

### Fixed
- Removed copied Google Drive session artifacts and stale DigiKey app credentials from the new project workspace.
- Replaced the old BOM-oriented app language with Part Scraper language throughout the new project docs and UI.
- Fixed live DigiKey throttling by restoring the missing `delay()` helper in the request queue.
- Fixed debug logging so live DigiKey runs append to `debug.log` reliably.
- Fixed live request handling so DigiKey timeouts return structured reasons instead of aborting comparison and ranking tool calls.
- Fixed tabular Skyworks email parsing so the live workflow extracts the five real impacted part numbers instead of leading with false positives like `SOT23` or product names.
