# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-08-30

Align clipboard format behavior across macOS, Linux, and Windows.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-08-21

Adopts mcp-ts-core ^0.12.3 (MCP SDK v2): JSON Schema 2020-12 advertised schemas with declared error envelopes, strict root inputs, supply-chain install scanner, TypeScript 7 toolchain, Bun 1.4 pin.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-15

Add server-level instructions for the clipboard_* tools; unscope the plugin manifests' display identity to the bare repo name (install args stay scoped).

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-11

Adopt @cyanheads/mcp-ts-core ^0.10.6: explicit server name/title identity, ValidationError contract codes, agent-doc-stripped bundles; add plugin manifests and repository/license metadata.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-26

align package.json and README to gold-standard patterns: bun scripts, funding, author, npm badge

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-25

fix server.json name/identifier and add mcpName for MCP Registry publishing

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-25

fix format_unavailable errors for RTF-absent/empty clipboard and HTML plain-text fallback

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

fix JXA NSData.length coercion in clipboard_inspect on macOS

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — clipboard read/write/inspect across macOS, Linux (X11/Wayland), and Windows
