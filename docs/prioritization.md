# Computed findings and priorities

The server computes findings from a verified immutable snapshot. The assistant can explain a finding and cite its ID; its narrative cannot change affected counts, evidence, classification, or priority. The analysis never infers business intent, ranking loss, traffic loss, or a shared template cause.

## Evidence and grouping

Each finding contains a stable ID, rule, section, exact deduplicated source row IDs, affected count, evidence, remediation, confidence, and the full priority rationale. IDs hash the rule, issue signature, and section; repeating the same issue in a later audit keeps the same ID.

Broken internal links group by observed failing destination and linking-page section. Their affected rows are **linking pages**; the destination row ID is separate evidence. Repeated copies of the same source-to-target link do not inflate reach. When link evidence is unavailable, failing crawled URLs are reported separately with destination URL counts, unknown linking-page reach, and a visible coverage gap. Membership in the extracted native Internal tab is authoritative, including aliases or subdomains classified as internal by an advanced configuration. Absolute native URLs use exact lookup keys; unmatched addresses remain unknown. Relative declarations are resolved against the source URL before an exact lookup.

Redirect paths use observed targets and known destination statuses. A memoized iterative traversal identifies shared final destinations and loops without recursive traversal or sampling. A path outside the snapshot remains unassessed. Single-hop internal redirects to successful destinations are low-priority opportunities when incoming links or an internal-inlink metric are observed. A failing final destination is a failure even after a single hop.

Canonical rules use observed declarations and known targets. An explicit native conflicting-canonical filter is evidence of a conflict. A declaration count greater than one alone produces a review opportunity: identical declarations are possible, and the extracted single canonical field does not expose every declaration. Noindex alone is informational, including a noindex page’s self-canonical declaration. Target indexability checks require completed native analysis. Canonical declarations can be observed on HTML pages or in HTTP headers for other document types; [Google documents both mechanisms](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls).

Sitemap rules require `inSitemap === true`. Unknown membership does not establish membership or absence. Response failures are independently assessable; non-indexable sitemap classifications require completed native analysis. These checks describe sitemap members represented in the snapshot, without asserting complete sitemap discovery. [Google recommends including preferred canonical URLs in sitemaps](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls).

Metadata rules cover successful, observed, indexable HTML pages. `null` means extraction unavailable; an empty string is an observed missing element. Duplicate text is exact after trimming and collapsing whitespace, with case preserved. Duplicates are detected across eligible pages and grouped by text signature and section. The evidence separately records the number of duplicate pages across sections. Multiple H1 headings and repeated metadata can be intentional. All metadata findings are opportunities requiring editorial review, not proof of technical failure. [Google’s title guidance recommends descriptive titles and avoiding repeated boilerplate](https://developers.google.com/search/docs/appearance/title-link).

## Priority formula

For each non-informational finding:

```text
score = severity × confidence
      + min(2, log10(affectedCount + 1))
      + knownInlinks ? min(2, log10(inlinkTotal + 1) / 2) : 0
      + knownClicks  ? min(1, log10(searchClicks + 1) / 3) : 0
```

The parentheses around each optional metric contribution are implied: unknown metrics contribute no boost. Severity is a documented engineering heuristic, not a prediction of search impact:

| Severity | Rules |
| --- | --- |
| 6 | Observed redirect loop |
| 4 | Broken destination, failing crawled URL, failing redirect target, explicit conflicting canonicals, failing or non-indexable canonical target, failing or non-indexable sitemap member |
| 3 | Redirect chain, invalid canonical URL, canonical-to-redirect opportunity, redirecting sitemap member |
| 2 | Missing, repeated, or multiple title elements; count-only multiple canonical declarations |
| 1 | Description and H1 opportunities; single-hop internal redirect opportunity |
| 0 | Noindex information |

Observed evidence uses confidence multiplier `1`; findings needing review use `0.75`. HTTP 403 and 429 responses use review confidence because access policy or rate limiting may explain the response. “Observed” establishes the extracted fact, not its business consequence or proposed cause.

Scores of at least `6` are high priority; at least `3` are medium; lower scores are low. Metadata opportunities are capped at medium regardless of reach or metrics. Single-hop internal redirect opportunities are capped at low. Canonical-to-redirect and sitemap-redirect opportunities are capped at medium. Information always has `info` priority. Scores are rounded to three decimal places before applying thresholds, which is disclosed in each finding’s evidence.

Internal-inlink totals and Search Console clicks are only summed when a valid metric is available for **every affected row**. Otherwise their totals remain `null` and the rationale says “unknown”; the number of rows with available metrics is separate evidence. Missing metrics are never represented as zero. No additional Search Console request or traffic estimate is made. Inlink totals are page metrics, not a count of unique referring pages across the whole finding.

Findings sort by priority, then descending computed score, then rule, section, and ID using deterministic string comparisons. Grouping identical evidence reduces fix lists without proving a template cause. Remediation explicitly labels shared-template explanations as hypotheses.

## Coverage and reconciliation

Each category reports `assessed`, `partial`, or `unassessed` and describes its scope, missing data, and the action needed. Independently observed response failures, metadata duplicates, and empty elements remain assessable before native post-crawl analysis completes; dependent indexability checks remain unassessed. Unknown response, content type, eligibility, redirect destination, canonical target, or sitemap membership is disclosed rather than guessed.

Every affected count equals the length of its sorted unique row-ID list. A URL can appear in multiple findings, so summing affected counts across findings is not a unique URL count. Report totals must distinguish finding count, unique affected URL count, and per-finding affected count. Duplicate issues split across sections retain exact section reach. Evidence strings are bounded to 2,000 characters; this does not truncate the affected row IDs or source dataset.

Snapshots with more than 100,000 URLs, non-sequential row IDs, or duplicate source URLs are rejected. No silent sampling occurs. Raw page HTML, complete link graphs, and assistant-authored quantities do not enter the computed audit result.
