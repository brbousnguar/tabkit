# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-14

### Added
- MCP server (stdio) with four read tools: `atlassian_whoami`, `jira_get_issue`, `jira_search_issues`, `confluence_get_page`
- Chrome extension (MV3) that runs each request as a same-origin `fetch()` in a tab of your Atlassian site, so it uses the session you are logged in with. No API token
- Pairing between the server and the extension with HMAC proofs over a shared token (`npm run pairing-token`)
- Read-only allowlist enforced in the extension: `GET`, plus `POST` to the Jira search endpoints
- `npm test` (server against a fake extension) and `npm run test:chrome` (real extension in Chrome for Testing)
