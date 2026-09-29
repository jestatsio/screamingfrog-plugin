# Native integration release gate

**Release gate: pending.** Controlled macOS SEO Spider 24.3 checks passed for connection, new crawl creation, exact identity, pagination, reconnect, and saved-crawl reload. An interrupted saved-load response was reconciled against the requested ID and same row set without repeating the load. The bundled-preset local pipeline produced 13 URLs and 14 findings and recovered after a deliberate disconnect. New/saved audits of the same native crawl produced identical snapshot hashes and findings, with 19 hyperlink rows. Actual stdio MCP discovery, finding/evidence queries, and HTML/CSV report generation passed. These selected results are recorded in the [public validation snapshot](validation-2026-09-29.json); raw local crawl records are excluded. Analysis readiness remains unassessed when native output provides only percentages. Windows native checks remain required before a validated release. Fixture checks are separate from licensed-app and assistant-host verification.

Follow Screaming Frog's [official MCP setup guide](https://www.screamingfrog.co.uk/seo-spider/user-guide/configuration/#mcp-server). Use a paid licence, database storage mode, the visible application, and its localhost HTTP MCP endpoint. Record exact operating system, CPU architecture, Screaming Frog version, assistant version, plugin commit/version, and configuration hash. Redact licence keys, account credentials, and private client URLs before sharing logs.

## Read-only preflight

1. Start native MCP in the visible application and run `npm run probe:native`; `npm run verify:native` also writes a read-only verification record.
2. Save the probe's capabilities, native tool input schemas, status shape, and crawl list in the verification record. Confirm available export fields and filters separately during the controlled checks.
3. Confirm `connection_status` succeeds and `list_crawls` reflects recent saved database crawls. Neither action should change the currently visible crawl.

The probe must not launch, load, pause, resume, or export a crawl. Connection and tool discovery are necessary evidence, not proof of correct snapshot acquisition.

## Controlled licensed-app checks

Use a test site you control and a dedicated test crawl. These checks deliberately change the visible application and crawl state. `npm run verify:native -- --run-local-test` runs the guarded localhost fixture on a dedicated blank application; it records a single launch intent before starting and does not retry an ambiguous launch. Do not run it against a client crawl. Keep these mutations separate from the read-only probe.

| Check | Required evidence |
| --- | --- |
| Saved database crawl | Load a known crawl ID; native status proves that exact crawl is active |
| New crawl | The bundled profile, real exported configuration, or explicit current-settings choice is recorded; applied settings are independently checked; exactly one crawl starts and receives an identifiable ID |
| Identity | ID remains stable before, during, and after export; an unexpected UI crawl switch rejects extraction |
| Pagination | Exact rows reconcile with the native UI, including empty, full-page boundary, and final partial pages |
| Completion | Crawl, analysis, and any enabled API collection readiness can be determined; missing readiness blocks dependent checks |
| Recovery | Disconnect/reconnect during start and extraction preserves identity; ambiguous start is reconciled without duplicate launch |
| Serialization | Two plugin processes cannot concurrently switch/extract the visible application |
| URL limit | More than 100,000 URLs is explicitly rejected, with no silent sampling |
| Data budget | Selected extraction, link-evidence stores, normalized snapshots, analysis candidate/finding datasets, and report payloads each reject more than 128 MiB without sampling |
| Preset | Genuine native `.seospiderconfig` passes the versioned extraction/analysis checklist on both platforms |

If reliable crawl identity is unavailable, snapshot acquisition remains blocked. If required analysis evidence is unavailable, the audit must say which categories are unassessed and explain the user action needed.

The nine-tool workflow is available provisionally while these checks continue. New URL audits default to [technical-audit-v1](../presets/technical-audit-v1.md), a genuine macOS SEO Spider 24.3 export whose path native MCP accepted. Its exact hash and configured settings are recorded, with provenance `technical-audit-v1:provisional-24.3-export`. Safe Java-stream privacy review found no credentials or private home paths. Applied-setting checks and Windows verification remain pending. Advanced users may supply a genuine `configPath` or explicit `useCurrentConfig: true`. Current-settings provenance must not claim the technical-audit profile was applied.

`advanced-config:observed-sha256:<hash>` identifies configuration bytes observed before launch, not a verified applied profile. Preserve that distinction in evidence and reports. Manually open the generated local HTML to verify offline loading, filters, detail pagination, CSV downloads, and unusual URL/text handling; browser functional verification remains pending.

Complete the native checks on both macOS and Windows before claiming a validated release. Install each artifact in Claude Desktop, Claude Code, and local Codex on both systems and test the flagship request. Record installation, native connection, crawl control, audit reconciliation, report generation, and offline report use separately. All six host/OS journeys remain pending.

## Evidence record

For each run, record date/time, OS and app versions, plugin commit, tool schemas, native crawl/config identities, expected/actual row counts, test steps, result, and relevant redacted diagnostics. Include a screenshot only when it proves a visible state not established by the MCP responses. Store test data outside version control unless it is synthetic and safe to redistribute.

Do not mark compatibility passed from fixture results, an artifact build, a single platform, or a healthy endpoint. Update the [compatibility matrix](compatibility.md) only after the respective real checks pass. Marketplace submissions and public release publication follow verification.
