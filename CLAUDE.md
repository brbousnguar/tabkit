# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
npm install
npm test                 # node:test over test/*.test.js: server + fake extension, no browser, no network
npm run test:chrome      # real extension in headless Chrome for Testing, against a public Jira Cloud site
npm run -s pairing-token # print (and create on first run) the pairing token
```

Plain ES modules, no build step: `src/` and `extension/` ship as they are. Node 20+.
Use `TABKIT_PAIRING_TOKEN` and `TABKIT_PORTS` in tests, so a test never touches a real
`~/.tabkit/pairing-token` or the default ports.

## Architecture

- `src/index.js`: the MCP server (stdio), its four read tools, and the error hints (401 means "log in in Chrome").
- `src/bridge.js`: `ExtensionBridge`, a WebSocket server on 127.0.0.1, first free port of the range.
  It accepts only a `chrome-extension://` origin, pairs with HMAC proofs, then relays requests.
- `src/pairing.js`: the pairing token file (0600, created once).
- `extension/`: Chrome MV3. `background.js` connects to every port of the range, answers the
  handshake, and runs each request as a `fetch()` inside a tab of the site with `chrome.scripting`.
  `protocol.js` is shared with the server (port range, nonces, HMAC). `settings.js` and `popup.*`
  hold the site, token and ports.

## Invariants

- **Read-only, in the extension too.** `background.js` sends `GET`, plus `POST` only to the paths in
  `READ_POSTS` (Jira search endpoints that exist only as POST). A write tool would be a different product.
- **The cookie stays in Chrome.** The extension never reads cookies; the server only sees status and body.
- **Pairing before anything.** No request is relayed before both sides proved the token. The token never
  crosses the socket and never lands in an MCP config or the repo.
- **Nothing company-specific in this repo**: no customer names, Atlassian sites, project keys or page ids.
  The site is set by each user in the popup; examples use `PROJ`.
- `protocol.js` is imported by both sides: keep it free of Node-only and Chrome-only APIs.
