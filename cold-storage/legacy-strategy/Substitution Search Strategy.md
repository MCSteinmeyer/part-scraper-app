# Substitution Search Strategy

## Purpose

This document preserves the search strategy for finding substitution parts when normal web and distributor searches do not reveal enough good candidates.

Default web searches often uncover only a small number of manufacturers and brands. The Part Scraper workflow should use the broader manufacturer reference in `semiconductor_and_ic_manufacturers.md` to search more deliberately across manufacturers and brands that may produce similar parts.

## Strategy Overview

When the workflow receives a source part, GPT/App should:

1. Identify what kind of part it is from the source description, DigiKey category, technical parameters, and available datasheets or web research.
2. Map that part type to likely manufacturer groups from `semiconductor_and_ic_manufacturers.md`.
3. Search beyond the original manufacturer and part family.
4. Score each manufacturer for that part type based on whether useful candidates were found.
5. Store manufacturer search results and scores in the project database.
6. Use stored scores to prioritize future searches for similar part types.
7. Update the stored scores as new workflow queries are performed.

The goal is not to create a one-time static manufacturer list. The goal is to build an improving search memory that learns which manufacturers and brands are productive for each part type.

This widening step should still run even when DigiKey already has an active direct match for the source part. A good direct match is useful, but it should not suppress cross-manufacturer discovery. Step 7 should still try to uncover all practical manufacturers that appear to make the same part type.

The manufacturer-search pass should not stop just because the app already has enough candidate part numbers to display. Continue the planned manufacturer searches so the database captures broader evidence about which manufacturers do or do not make that part type, even if the visible shortlist is already full.

## Part Type Classification

Before searching manufacturers, classify the source part into a practical part type.

Examples:

- RF PIN diode
- RF limiter diode
- varactor / tuning diode
- Schottky RF detector diode
- step-recovery diode
- RF switch
- RF amplifier / MMIC
- MOSFET
- TVS / protection diode
- voltage regulator
- op amp
- logic IC
- microcontroller

Classification should use:

- DigiKey category and child category
- manufacturer description
- detailed description
- technical parameters
- package / case
- supplier device package
- datasheet wording when available
- context from the pasted email

If classification is uncertain, store the best available label and a confidence value instead of forcing a precise category.

## Manufacturer Search Process

For each classified part type, search manufacturers in priority order.

Priority sources:

- all manufacturers on the first pass for a part type, unless the database already has a valid exclusion score for that manufacturer and part type
- manufacturers already known to make that part type
- manufacturers listed in the relevant section of `semiconductor_and_ic_manufacturers.md`
- manufacturers that scored well on previous similar searches
- manufacturers with active parts in stock from prior database records

Search examples:

- `<manufacturer> RF PIN diode SOT-23 20V`
- `<manufacturer> limiter diode SOT-23 replacement`
- `<manufacturer> varactor diode SOT-23 capacitance`
- `<manufacturer> <source technical phrase> substitute`
- `<manufacturer> <source part type> <package>`

Search should include DigiKey first when possible, then broader web research when DigiKey does not reveal enough candidates.

When DigiKey returns a candidate that is still active or otherwise still legitimately listed, preserve the manufacturer name DigiKey shows for that candidate so the workflow output can explicitly say who is making or listing the part now.

## Database Memory

Store the search memory in the local SQLite database using two related concepts: a long-term score summary and a detailed search-attempt history.

Manufacturer score summaries should answer: "Does this manufacturer appear to make this kind of part, and how useful is it to search them for this part type?"

Suggested fields:

- manufacturer name
- normalized manufacturer key
- part type
- package family
- important electrical class, such as voltage range, capacitance range, current range, or frequency range
- score
- confidence level
- attempt count
- miss count
- success count
- active candidate count
- in-stock candidate count
- exclusion status
- reason for exclusion, if any
- first searched timestamp
- last searched timestamp
- last successful search timestamp

Manufacturer search attempts should answer: "What did we search, what happened, and what evidence supports the score?"

Suggested fields:

- manufacturer name
- normalized manufacturer key
- part type
- package family
- source part number
- source part technical summary
- search query used
- search source, such as DigiKey, web search, manufacturer site, or datasheet
- candidate part numbers found
- candidate count
- active candidate count
- in-stock candidate count
- rejected candidate count
- result classification, such as `success`, `miss`, `partial`, or `error`
- raw supporting data or a reference to raw cached lookup records
- searched timestamp

Do not store source-to-candidate match scores, category explanations, candidate review reasons, or candidate ranking notes in the long-term cache. Those values are only valid when compared against one specific reference part and should be recomputed during `parts.compare_parts` or `parts.rank_substitutes`.

Do store the manufacturer identity returned by DigiKey or another primary-source lookup for each candidate part. Manufacturer identity is part data, not a source-specific comparison score, and it should be available later when the workflow needs to show who is still making or listing an allowed candidate.

Use these result classifications:

- `success`: the search completed and found at least one candidate in the same practical part type.
- `miss`: the search completed, but found no products in the same practical part type.
- `partial`: the search completed and found related products, but did not find a clear viable candidate.
- `error`: the search did not complete for technical reasons, such as an API failure, network problem, blocked page, parsing failure, or temporary site problem.

Do not discard failed searches. Failed searches are useful because they help avoid repeatedly searching manufacturers that do not make a useful part type.

## Manufacturer Scoring

Score each manufacturer for a part type after a search. This is a manufacturer capability score, not a final substitute ranking score. It should estimate whether a manufacturer appears to make parts in the same practical part type as the source part.

The purpose of the score is to solve the gap left by generic web searches: it is not always clear from broad search results which manufacturers actually make a given kind of part. The workflow should first determine the source part type, then score manufacturers under that part type based on search evidence.

Use a `0-100` score:

- `0` means the manufacturer should not be searched again for this part type unless the user explicitly asks.
- `1-39` means weak evidence or repeated misses for this part type.
- `40-69` means possible manufacturer for this part type, but evidence is limited or mixed.
- `70-89` means useful manufacturer for this part type.
- `90-100` means high-value manufacturer for this part type with repeated useful results.

Use `50` as the seed score when initializing a manufacturer and part-type pair in the database.

Initial values:

- score: `50`
- confidence level: `low`
- attempt count: `0`
- miss count: `0`
- success count: `0`
- exclusion status: `active`

Suggested first-pass score movement:

- first miss: lower score to about `25`
- second miss: lower score to `0` and exclude that manufacturer for that part type
- partial result: keep score around `45-60` depending on usefulness
- one useful result: raise score to about `70`
- repeated useful results: raise score into the `85-100` range

Only completed searches should affect the manufacturer capability score. Do not lower the score for `error` results. DigiKey failures, network errors, blocked web searches, parsing failures, or temporary site problems should be stored in the search-attempt history, but they should not lower the manufacturer capability score unless later completed searches confirm the manufacturer does not make that part type.

Confidence level measures how much evidence supports the manufacturer capability score.

Use these confidence levels:

- `low`: 0-1 completed search attempts.
- `medium`: 2-5 completed search attempts, or mixed/conflicting evidence.
- `high`: 6 or more completed search attempts with consistent outcomes.

Only completed result classifications, such as `success`, `miss`, or `partial`, should increase confidence. `error` results should be stored in search-attempt history, but they should not increase confidence.

Positive signals:

- manufacturer search results show products in the same practical part type
- found one or more plausible technical matches
- found active lifecycle parts
- found parts with real distributor stock
- found package-compatible candidates
- found datasheets with matching electrical parameters
- prior successful substitutions for the same part type

Negative signals:

- no matching products found
- search results suggest the manufacturer does not make this practical part type
- only obsolete parts found
- only parts with excluded lifecycle labels found
- only eval boards, kits, modules, or unrelated assemblies found
- package mismatch for drop-in needs
- missing datasheets or missing technical parameters
- repeated completed misses for the same part type

The score should decay or be refreshed over time, because manufacturer product lines and distributor stock can change.

Use two refresh windows:

- stock-sensitive search results should be refreshed after 30 days
- manufacturer capability scores should be refreshed after 180 days

Stock-sensitive data includes availability, active stock count, price, distributor packaging, and lifecycle status. Manufacturer capability data is the broader evidence that a manufacturer does or does not make useful parts for a given part type.

## Lifecycle Labels

Treat these lifecycle labels as excluded for viable new substitute recommendations:

- `Obsolete`
- `Discontinued`
- `End of Life`
- `EOL`
- `Not Recommended for New Designs`
- `Not For New Designs`
- `NRND`
- `Last Time Buy`
- `Last Time Purchase`

Store parts with these labels for traceability, but do not present them as viable recommendations unless the user explicitly asks to include them for review.

## Exclusion Rules

Use `Manufacturer Scoring` to decide whether a manufacturer should be excluded from deeper searches for a specific part type.

On the first pass for a new part type, search all manufacturers from the relevant manufacturer list. After that, use the stored manufacturer capability score to decide whether a manufacturer should be skipped for that part type. A practical starting rule is that two completed misses lower the score to `0` and set the exclusion status for that manufacturer and part type.

Good exclusion reasons:

- `no_products_for_part_type`
- `only_obsolete_products`
- `only_not_recommended_for_new_design`
- `no_package_compatible_products`
- `only_eval_or_demo_boards`
- `technical_parameters_do_not_overlap`
- `manufacturer_site_no_longer_lists_category`

Exclusion should be scoped. Do not exclude a manufacturer globally just because it failed for one part type.

Example:

- MACOM may remain highly relevant for RF PIN diodes.
- A power-only manufacturer may be excluded for RF limiter diodes but still remain useful for MOSFET or SiC diode searches.

## Auto-Update Behavior

The search strategy should update itself during the normal `WORKFLOWS.md` process.

During candidate discovery, currently Step 7 in `WORKFLOWS.md`:

- read existing manufacturer scores for the classified part type
- prioritize high-scoring manufacturers
- still run at least one real widening pass for the classified part type even when the source part already has an active DigiKey match or same-manufacturer substitute options
- still sample some unknown or low-confidence manufacturers when the candidate pool is weak
- store every meaningful search result
- update manufacturer scores after ranking candidates
- record why a manufacturer was productive or unproductive

This keeps the database useful without requiring a separate manual maintenance workflow.

## Candidate Handling

Candidate parts found through manufacturer searches should still pass through the normal ranking workflow.

Do not recommend a candidate just because the manufacturer appears relevant.

A viable candidate still needs:

- compatible package
- compatible electrical parameters
- acceptable lifecycle status
- real availability or a clear sourcing path
- review notes for any uncertainty

If a candidate remains on the viable shortlist, the output should explicitly show the manufacturer identity reported by DigiKey or the primary source. For `active` parts, prefer wording equivalent to `Still manufactured by: <manufacturer>`. For weaker lifecycle states that are still shown for traceability, use wording that makes it clear the manufacturer name is being reported from DigiKey rather than claimed as a fully approved new-design recommendation.

Parts with excluded lifecycle labels should be stored for traceability but excluded from viable recommendations unless the user explicitly asks to include them.

## Practical Search Loop

For a random source part from the workflow:

1. Classify the part type.
2. Load prior manufacturer scores for that part type.
3. Search known-good manufacturers first.
4. Search relevant manufacturers from `semiconductor_and_ic_manufacturers.md`.
5. Score and store the results.
6. Exclude manufacturers from further searches for that part type when evidence supports exclusion.
7. Send discovered candidate parts into `rankSubstituteCandidates(...)` or `parts.rank_substitutes`.
8. Print the final side-by-side comparison table in chat, including an explicit manufacturer line for any candidate that remains on the shortlist.

## Initial Implementation Notes

The first implementation can be simple:

- add one SQLite table for manufacturer search scores
- add one SQLite table for manufacturer search attempts
- update those tables during candidate discovery
- use the stored scores to sort future manufacturer search order

Avoid overfitting early. The database will become more valuable as real workflow searches accumulate.
