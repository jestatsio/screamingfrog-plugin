# Compatibility and validation status

Version 0.1.0 is a provisional audit implementation. The compiled server targets Node.js 20+, licensed native MCP, macOS, and Windows. Development requires Node.js 20.19+, 22.12+, or 24+. Windows verification remains a release gate. Selected local results are recorded in the [public validation snapshot](validation-2026-09-29.json).

| Host | macOS installation/workflow | Windows installation/workflow | Package |
| --- | --- | --- | --- |
| Claude Desktop | Pending | Pending | `.mcpb` |
| Claude Code | Pending | Pending | ZIP with `.claude-plugin/plugin.json` |
| Local Codex | Pending | Pending | ZIP with portable and compatibility manifests |
| Generic local MCP client | Pending | Pending | stdio `node dist/cli.js` |

| Gate | Status |
| --- | --- |
| Licensed macOS native connection | Observed with SEO Spider 24.3; schemas and response shapes captured |
| macOS new crawl, identity, pagination, reconnect, saved reload | Passed controlled localhost checks; interrupted saved load reconciled exact ID and rows without repeating the load |
| macOS local audit pipeline | Passed for controlled 13-URL crawl with 14 findings and deliberate disconnect recovery |
| macOS new/saved findings equivalence | Passed for the same native crawl: 13 identical snapshot rows, 14 findings, and 19 hyperlink rows |
| Real stdio MCP finding/report workflow | Passed: nine tools discovered, bounded findings/evidence queried, HTML and two CSVs generated |
| Compiled stdio saved-audit workflow | Passed with matching snapshot/findings and report generation |
| Native analysis readiness | Unassessed where only percentages are available; percentages do not prove readiness |
| Licensed Windows native integration | Pending release gate |
| Native technical-audit preset | Genuine macOS 24.3 capture; native path accepted and privacy review passed; applied settings and Windows checks pending |
| Nine-tool audit implementation | Provisional; source, fixtures, and synthetic reports require exact-head checks |
| Synthetic 100,000-URL report | Node generation passed with 2,000 findings: 2,738,382 HTML bytes, 459.3 ms generation, 0.036 ms filter p95, 0.055 ms indexed lookup p95, 440.1 MiB RSS; browser responsiveness unverified |
| Offline report/browser interaction | Pending manual local-file validation |
| Fixture/type/build checks | Local checks have passed; rerun `npm run check` for the final revision. `npm audit` reported zero vulnerabilities on 2026-09-29 |
| Packages | `npm run package:plugins`; development artifacts until host/OS checks pass |
| Validated release / marketplace submissions | Not performed |

The 100,000-URL cap also has a 128 MiB budget for each selected extraction, link-evidence store, normalized snapshot, analysis candidate/finding dataset, and report payload. Exceeding a limit fails explicitly without sampling.

The [public validation snapshot](validation-2026-09-29.json) records the selected counts, snapshot hash, benchmark measurements, package checks, and unresolved gates. Raw local crawl records and native screenshots are excluded from the repository. Observed crawl completion does not establish post-crawl analysis readiness.

The [native checklist](native-verification.md) separates connection, reliable snapshot acquisition, control/recovery, real configuration, and assistant-host testing. All six target host/OS installation journeys remain pending. A healthy endpoint, synthetic report, CI job, or generated package does not satisfy those gates.
