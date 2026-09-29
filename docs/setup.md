# Install the provisional audit plugin

The same compiled `dist/cli.js` supplies the nine audit tools to all hosts. Use a local client on the same machine as the licensed Screaming Frog application. Version 0.1.2 remains provisional: Windows native checks and all six host/OS installation journeys are pending; see the [compatibility matrix](compatibility.md).

The **[installation page](https://jestatsio.github.io/screamingfrog-plugin/)** offers prebuilt development previews. They include the compiled server and production dependencies, so users do not need to clone the repository, run npm, or build anything. Keep the visible Screaming Frog application running in database storage mode with native MCP enabled. It normally serves `http://127.0.0.1:11435/mcp`.

## Claude Desktop

**[Download for Claude Desktop](https://github.com/jestatsio/screamingfrog-plugin/releases/download/v0.1.2-preview.1/jestats-screamingfrog-audit-0.1.2-preview.1.mcpb)**, open the downloaded `.mcpb`, and review and confirm **Install**. Claude Desktop supplies the compatible Node.js runtime. If opening the file does not show the installer, use **Settings > Extensions > Advanced settings > Install Extension…** and select it. Restart the app if needed. This download/open/confirmation flow is described in [Anthropic's desktop extensions guide](https://www.anthropic.com/engineering/desktop-extensions).

The extension exposes a localhost endpoint setting and an optional directory for persisted audit jobs, immutable snapshots, and reports. Leave **Local audit storage** blank to use `.jestats/screamingfrog` in your home directory, or select an absolute directory. Neither setting requires a password or licence key. Native licence activation stays in Screaming Frog. The bundle format follows the [official MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).

Version 0.1.2 includes the original JEStats frog-auditor icon. Install the new package and restart the host to pick up its updated logo metadata; visible rendering inside Claude Desktop and Codex remains to be checked. See the [branding guide](branding.md) for the artwork and supported host fields.

**Upgrading from 0.1.0:** install the updated `.mcpb` and restart Claude Desktop. Version 0.1.1 handles the exact legacy `${HOME}/.jestats/screamingfrog` default if it survives in saved extension settings. The new bundle uses a blank setting so the server chooses the home directory directly.

## Claude Code

In **Claude Code 2.1.275+**, paste this into an interactive session:

```text
/plugin install jestats-screamingfrog-audit --marketplace jestatsio/screamingfrog-plugin
```

Confirm adding the community marketplace and installing the plugin in the desired scope. Claude Code fetches a prebuilt release ZIP and verifies its SHA-256. **Node.js 20+** must be available to launch the server.

For **Claude Code 2.1.224+**, use two shell commands instead:

```sh
claude plugin marketplace add jestatsio/screamingfrog-plugin
claude plugin install jestats-screamingfrog-audit@jestats-plugins
```

Restart the session after installation. See the official [one-command installation instructions](https://code.claude.com/docs/en/plugins/install#add-a-marketplace-and-install-in-one-command) and [archive source requirements](https://code.claude.com/docs/en/plugins/marketplace-reference#archive-plugin-source). For a manual/session-only alternative, download `*-claude-code.zip` from the [prerelease](https://github.com/jestatsio/screamingfrog-plugin/releases/tag/v0.1.2-preview.1), extract it, and run `claude --plugin-dir "/absolute/path/to/extracted-plugin"`.

## Local Codex

With a current Codex CLI and **Node.js 20+**, run:

```sh
codex plugin marketplace add jestatsio/screamingfrog-plugin
codex plugin add jestats-screamingfrog-audit@jestats-plugins
```

The repository's community catalog points at an immutable prebuilt Git snapshot. Codex downloads the plugin and its dependencies without an npm build. Restart your local session/app after installation. Marketplace CLI commands were inspected on Codex CLI 0.159.0; older clients may need an update. See the [official packaging and marketplace reference](https://developers.openai.com/plugins/build/plugins#marketplace-metadata).

After registering the marketplace, the installation page's **Open in Codex** button uses:

```text
codex://plugins/install/jestats-screamingfrog-audit?marketplace=jestats-plugins
```

This route was verified in the installed desktop app's parser. It opens the plugin's details/install screen and requires an already registered marketplace; it does not silently install or add a marketplace. If a browser cannot launch Codex, use the CLI commands above. GitHub's Markdown renderer may omit custom-protocol links, so the clickable button lives on the installation page.

For a manual/local alternative, download the `*-marketplace.zip`, extract it, and run `codex plugin marketplace add "/absolute/path/to/extracted-marketplace"`, followed by the same `codex plugin add` command. The portable `plugin.json` and `mcp.json` launch `${PLUGIN_ROOT}/dist/cli.js`. The compatibility manifest also points to `mcp.json`; actual host usability remains a validation gate.

## Updates and removal

Preview packages stay pinned to reviewed content. A future release updates the public catalogs. In Claude Code, run `claude plugin marketplace update jestats-plugins`, then `claude plugin update jestats-screamingfrog-audit@jestats-plugins`. In Codex, run `codex plugin marketplace upgrade jestats-plugins`, then follow the available plugin update/reinstall flow for your host. Manually installed Claude Desktop bundles require downloading and installing the new `.mcpb`.

To remove a CLI installation, use `claude plugin uninstall jestats-screamingfrog-audit@jestats-plugins` or `codex plugin remove jestats-screamingfrog-audit@jestats-plugins`. Stored local audit data is separate from the host's plugin cache.

## Build from source

For development, use Node.js 20.19+, 22.12+, or 24+, run `npm ci`, then `npm run check`. Run `npm run package:plugins` to generate timestamped archives, checksums, and a complete local marketplace. Load the built source with `claude --plugin-dir "/absolute/path/to/screamingfrog-plugin"`, or add its compiled MCP server directly:

```sh
codex mcp add jestats-screamingfrog -- node "/absolute/path/to/screamingfrog-plugin/dist/cli.js"
```

This direct MCP configuration does not install the audit skill. Set a nondefault native endpoint by adding `--env SCREAMINGFROG_MCP_URL=http://127.0.0.1:11435/mcp` before `--`.

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

If version 0.1.0 reports `mkdir '/${HOME}'`, its storage-directory placeholder reached the server without expansion. Update to 0.1.1 or newer, or set **Local audit storage** to an absolute path in the extension settings and restart Claude Desktop. Connection checks and an empty audit list do not verify that storage can be written. The upstream [nested-default interpolation issue](https://github.com/modelcontextprotocol/mcpb/issues/251) describes this failure mode.

Only loopback HTTP endpoints are accepted. This server is designed for local licensed-user access. No OAuth flow or remote Screaming Frog account linking is required.

## Run an audit

Call `connection_status`, then select a saved database ID with `list_crawls` or provide a URL for a new crawl. New crawls default to the bundled `.seospiderconfig`, a genuine macOS 24.3 capture candidate whose path native MCP accepted. Privacy review found no credentials or private home paths; applied-settings and Windows checks remain pending. Provenance is `technical-audit-v1:provisional-24.3-export`. Review its [preset notes](../presets/technical-audit-v1.md). Override it with an exported native `configPath` or explicit `useCurrentConfig: true` when needed. The Markdown checklist cannot be passed as a configuration file. Current settings can omit extraction or analysis, so review recorded provenance and coverage gaps.

For `configPath`, the recorded SHA-256 is an observation of file bytes before launch, not proof that the application applied those settings. Verify applied configuration separately. A current-settings choice likewise does not establish that the audit checklist was applied.

Retain the ID returned by `start_audit`. Use `audit_status` to advance/reconcile that job and `list_audits` to find it after reconnecting. A disconnect or ambiguous launch is a reason to reconcile the existing job, not launch another crawl. Inspect `list_findings` and `finding_details`, then call `render_report` for the local HTML and CSV paths. Use `control_audit` for pause, resume, or cancellation.

Cancellation records the local job as cancelled even when disconnected. It attempts native pause only for the exact crawl the job owns. Review returned diagnostics: local cancellation does not guarantee the visible application has stopped crawling.

Job checkpoints advance only when the assistant calls `audit_status` or an applicable control action; there is no background worker.

Saved-crawl snapshots require a stable database identity and suitable idle/data state. A healthy endpoint or a 100% progress figure alone does not establish crawl or analysis readiness. The report must disclose unassessed categories.

Audits are limited to 100,000 URLs and 128 MiB for each selected extraction, link-evidence store, normalized snapshot, analysis candidate/finding dataset, and report payload. A limit failure is explicit; no crawl rows are silently sampled. Reduce the configured crawl scope or selected data before starting a new audit.
