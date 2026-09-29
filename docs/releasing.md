# Publish a development preview

The community catalogs use prebuilt content. Users install the runtime and its production dependencies without building from source. Keep previews marked as GitHub prereleases until the [compatibility gates](compatibility.md) pass.

1. Run `npm run check`, review the change, and commit the source. Build with `npm run package:plugins` after committing so the release metadata records the correct source revision.
2. Inspect the four timestamped archives, SHA-256 file, and generated local marketplace. Validate its Claude catalog and plugin with `claude plugin validate <directory> --strict`. Packaging tests start all four extracted runtimes without an npm install; licensed native and host checks remain separate.
3. Publish the prebuilt marketplace tree as a Git snapshot in `fix/prebuilt-plugin`. Preserve its history for future previews and include `DISTRIBUTION.json` with the original source revision. Keep source development on `main`.
4. Pin `.agents/plugins/marketplace.json` to the distribution commit's immutable `sha`. Pin `.claude-plugin/marketplace.json` to the Claude Code ZIP's exact release URL and `sha256`. Update `docs/distribution.json`, install-page links, and README links. Review catalogs before pushing.
5. Create a GitHub prerelease at the source revision and upload archives and checksums. The Desktop button uses a friendly versioned `.mcpb` filename with identical bytes to the generated bundle. Include both names in the checksum file if both are uploaded. Never upload raw `*-RELEASE.json`, which includes a local workspace path; publish sanitized provenance in `docs/distribution.json`.
6. Deploy only `site/` using the Pages workflow. Verify download links, copy controls, assistant anchors, responsive layout, and catalog pins against release bytes.

A parsed app link, package startup, marketplace fetch, or CI job does not establish that a complete audit works in that assistant and operating system. Update the compatibility matrix only with observed evidence.
