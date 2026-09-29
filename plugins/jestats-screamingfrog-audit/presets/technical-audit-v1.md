# Technical audit preset v1

**Status: genuine capture candidate; validation pending.** [technical-audit-v1.seospiderconfig](technical-audit-v1.seospiderconfig) was exported through a fresh licensed macOS SEO Spider 24.3 installation with no API accounts configured. It is a 38,399-byte native Java serialization file, and native MCP accepted its path. New URL audits select it by default with provenance `technical-audit-v1:provisional-24.3-export`. Applied-settings verification and Windows compatibility remain release gates. This Markdown checklist cannot be passed as `configPath`.

Read-only inspection of the complete serialized structure found no stored credentials, private home paths, credential-bearing URLs, or personal email addresses. Authentication and cookie entries are configuration flags or enums.

Captured file SHA-256: `241dab5bd25edee287b778e29e7918559e7f3d4bb728f8c414a7d89ed754dd38`. See [machine-readable metadata](technical-audit-v1.metadata.json). Recompute the hash after any change; packaging rejects a size/hash mismatch. A matching file hash establishes file identity; it does not prove the application applied the profile.

The exported settings were configured for:

- Standard HTML crawling with text-only rendering.
- Hyperlink and canonical crawling/storage, plus extraction of titles, descriptions, H1s, and indexability.
- Linked XML sitemap crawling and sitemap discovery through robots.txt.
- Automatic analysis at the end of the crawl.
- No raw HTML or rendered HTML storage.
- A native crawl limit of 100,001, so the plugin can detect and reject a crawl exceeding its 100,000-URL limit instead of accepting a silently truncated 100,000-URL crawl.

Before relying on this candidate, load its absolute path on the same machine as Screaming Frog and check the applied settings through the native application. Review it for authentication, private paths, client-specific scope, or other private settings before redistribution. Validate the following on licensed macOS and Windows installations:

- The intended internal scope and robots behavior are appropriate for the test site.
- Status code, content type, indexability/reason, canonical declarations/count, title/count, description/count, H1/count, and unique inlink fields are available.
- Sitemap membership and non-indexable sitemap entries can be assessed.
- Automatic analysis runs, and crawl, analysis, and any enabled API readiness can be verified independently of percentages alone.
- Internal inlinks and redirect destination/chain evidence can be exported; missing evidence remains a coverage gap.
- Search Console metrics are optional and only used when already present; the plugin does not connect a Google account.
- Oversized crawls or datasets fail explicitly without sampling: 100,000 URLs and 128 MiB per selected extraction, link-evidence store, normalized snapshot, analysis candidate/finding dataset, and report payload.

Record the platform, Screaming Frog version, exact config filename/hash, applied-setting checks, and data coverage in the [native verification record](../docs/native-verification.md). Advanced profiles and explicit current-settings choices must also expose their provenance and coverage gaps. Never synthesize undocumented configuration keys or rename JSON to `.seospiderconfig`.
