# Part Scraper Changelog

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
