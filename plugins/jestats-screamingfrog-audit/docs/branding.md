# JEStats frog-auditor branding

![Original JEStats frog auditor](../assets/frog-auditor.png)

The original mascot combines a frog, an audit clipboard, a magnifying glass, and the JE monogram. Its palette follows the JEStats website: charcoal `#111827`, orange `#D9531E`, forest green `#1B4D3E`, and cream `#FAF9F5`. Existing mascot artwork was not used as an input.

## Assets and host integration

- `assets/frog-auditor.png`: original 1254 × 1254 RGBA PNG, 976,556 bytes, with genuine transparent corners. Created with the built-in `image_gen` tool; copied without editing.
- Claude Desktop: MCPB `icon` points to the bundled PNG.
- Codex: portable and compatibility interfaces set `logo`, `logoDark`, and `composerIcon` to the same package-relative PNG; `brandColor` is JEStats orange.
- Claude Code: its documented manifest has no custom icon field. The same artwork is included in its package and the shared README.
- The installation page uses the same source PNG. Pages copies only that image into its site artifact; no remote image request is required.

The package test checks icon format/dimensions, exact delivered bytes, and host asset references. A separate pixel inspection confirmed a fully transparent corner. These checks verify the configured assets; installation display in the actual host still requires a visual check.

References: [MCPB icons](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md#icons), [OpenAI-specific metadata](https://developers.openai.com/plugins/build/plugins#add-openai-specific-metadata), [OpenAI image requirements](https://developers.openai.com/plugins/deploy/submission#icons-and-screenshots), [Claude Code manifest](https://code.claude.com/docs/en/plugins-reference).

## Generation prompt

```text
Use case: logo-brand.
Asset type: original transparent mascot logo for JEStats technical SEO audit plugin icons, README, and installation page.
Primary request: an original friendly frog doing a website audit, connected to JEStats' existing charcoal-square JE monogram branding.
Subject: one compact, charming forest-green frog with a rounded head, modest eye bumps, alert dark eyes and a subtle confident closed-mouth smile. Show its full compact upper body sitting upright, inspecting a cream audit clipboard with a magnifying glass. Clipboard has one simple orange ascending bar chart and a clear checkmark, not tiny rows of writing. A small charcoal square on the clipboard contains exactly the white letters "JE", styled as a simple bold monogram.
Style/medium: premium contemporary flat mascot logo illustration with crisp clean vector-like contours, substantial charcoal outlines, simple confident shapes, a very restrained two-tone treatment, no realistic texture. Professional and personable. Strong silhouette readable as a 48px app icon.
Composition/framing: square, one centered mascot fills approximately 80 percent of the frame, generous consistent transparent padding on all sides. Entire frog, clipboard, and magnifying glass visible, no cropping. Let the clipboard and magnifying glass be unmistakable yet secondary to the friendly frog face. No wordmark outside the character, no border, no background badge.
Colour palette: forest green #1B4D3E body with a slightly lighter green for legibility, charcoal #111827 outlines and pupils, warm orange #D9531E for the magnifying-glass rim and chart, warm cream #FAF9F5 belly and paper. Use these JEStats brand colours, avoid neon mint.
Constraints: genuinely transparent background; one complete original logo only, no sheet of variations, no mockup, no watermark. Apart from the small "JE" badge, no text. Create an independent frog character, without copying Screaming Frog branding, any existing frog mascot, or a famous cartoon character. Keep small-icon details simple and high contrast.
```

