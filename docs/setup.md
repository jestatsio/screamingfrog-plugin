# Install the provisional audit plugin

The same compiled `dist/cli.js` supplies the nine audit tools to all hosts. Use a local client on the same machine as the licensed Screaming Frog application. Version 0.1.0 remains provisional: Windows native checks and all six host/OS installation journeys are pending; see the [compatibility matrix](compatibility.md).

For building and testing, use Node.js 20.19+, 22.12+, or 24+. First run `npm ci` and `npm run check` from the repository. The compiled plugin supports Node.js 20+. Keep the visible Screaming Frog application running in database storage mode with native MCP enabled. It normally serves `http://127.0.0.1:11435/mcp`.

## Claude Desktop

Run `npm run package:plugins`, then select the generated `*-claude-desktop.mcpb` under **Settings > Extensions > Advanced Settings > Install Extension**. Review and install it, then restart the app if needed. The bundle includes its JavaScript and production dependencies. Your desktop host must provide a compatible Node.js runtime.

The extension exposes a localhost endpoint setting and a directory for persisted audit jobs, immutable snapshots, and reports. Neither setting requires a password or licence key. Native licence activation stays in Screaming Frog. The bundle format follows the [official MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).

## Claude Code

For development, load this built repository directly:

```sh
claude --plugin-dir "/absolute/path/to/screamingfrog-plugin"
```

For the ZIP distribution, extract `*-claude-code.zip` into a directory and point `--plugin-dir` at that directory. `.claude-plugin/plugin.json` identifies the plugin; root `.mcp.json` launches the packaged `dist/cli.js` using `${CLAUDE_PLUGIN_ROOT}`. The `audit` skill guides setup and only uses tools available in the installed build. See the [official Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference).

Validate a built directory when Claude Code is installed:

```sh
claude plugin validate "/absolute/path/to/screamingfrog-plugin" --strict
```

## Local Codex

For a direct MCP development connection:

```sh
codex mcp add jestats-screamingfrog -- node "/absolute/path/to/screamingfrog-plugin/dist/cli.js"
```

Restart your local chat/session after adding the server. This registers the tools; it does not install the bundled skill. To configure a nondefault endpoint, add `--env SCREAMINGFROG_MCP_URL=http://127.0.0.1:11435/mcp` before `--`.

For a complete local plugin, extract `*-codex.zip` under `plugins/jestats-screamingfrog-audit` in a separate local marketplace root. Add `.agents/plugins/marketplace.json` at that root:

```json
{
  "name": "jestats-local",
    "interface": { "displayName": "JEStats Local Audit" },
  "plugins": [{
    "name": "jestats-screamingfrog-audit",
    "source": { "source": "local", "path": "./plugins/jestats-screamingfrog-audit" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

Use `codex plugin marketplace add "/absolute/path/to/local-marketplace-root"` where supported, then install the plugin through your local Plugins Directory. The portable root `plugin.json` and `mcp.json` use `${PLUGIN_ROOT}`. The package also includes the compatibility `.codex-plugin/plugin.json` and `.mcp.json` layout. Local plugin installation varies by host version and still needs verification. Follow the [official OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins).

## Other local MCP clients

Use your client's stdio configuration with an absolute path:

```json
{
  "mcpServers": {
    "jestats-screamingfrog": {
      "command": "node",
      "args": ["/absolute/path/to/screamingfrog-plugin/dist/cli.js"]
    }
  }
}
```

On Windows, use forward slashes (`C:/Users/you/...`) or escape backslashes in JSON. Arguments are separate strings, so paths containing spaces do not need embedded quotation marks. If the host cannot find `node`, use its absolute executable path.

## Connection troubleshooting

Call `connection_status` before selecting a crawl. Connection refusal usually means the visible application's MCP server is stopped or the endpoint differs. A missing native tool or unrecognized result shape is a compatibility failure: retain the diagnostic output for the verification record rather than guessing a schema.

Only loopback HTTP endpoints are accepted. This server is designed for local licensed-user access. No OAuth flow or remote Screaming Frog account linking is required.

## Run an audit

Call `connection_status`, then select a saved database ID with `list_crawls` or provide a URL for a new crawl. New crawls default to the bundled `.seospiderconfig`, a genuine macOS 24.3 capture candidate whose path native MCP accepted. Privacy review found no credentials or private home paths; applied-settings and Windows checks remain pending. Provenance is `technical-audit-v1:provisional-24.3-export`. Review its [preset notes](../presets/technical-audit-v1.md). Override it with an exported native `configPath` or explicit `useCurrentConfig: true` when needed. The Markdown checklist cannot be passed as a configuration file. Current settings can omit extraction or analysis, so review recorded provenance and coverage gaps.

For `configPath`, the recorded SHA-256 is an observation of file bytes before launch, not proof that the application applied those settings. Verify applied configuration separately. A current-settings choice likewise does not establish that the audit checklist was applied.

Retain the ID returned by `start_audit`. Use `audit_status` to advance/reconcile that job and `list_audits` to find it after reconnecting. A disconnect or ambiguous launch is a reason to reconcile the existing job, not launch another crawl. Inspect `list_findings` and `finding_details`, then call `render_report` for the local HTML and CSV paths. Use `control_audit` for pause, resume, or cancellation.

Cancellation records the local job as cancelled even when disconnected. It attempts native pause only for the exact crawl the job owns. Review returned diagnostics: local cancellation does not guarantee the visible application has stopped crawling.

Job checkpoints advance only when the assistant calls `audit_status` or an applicable control action; there is no background worker.

Saved-crawl snapshots require a stable database identity and suitable idle/data state. A healthy endpoint or a 100% progress figure alone does not establish crawl or analysis readiness. The report must disclose unassessed categories.

Audits are limited to 100,000 URLs and 128 MiB for each selected extraction, link-evidence store, normalized snapshot, analysis candidate/finding dataset, and report payload. A limit failure is explicit; no crawl rows are silently sampled. Reduce the configured crawl scope or selected data before starting a new audit.
