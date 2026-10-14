#!/usr/bin/env node
// Opt-in end-to-end check in a real browser: the MCP server, the unpacked extension in
// Chrome for Testing, and a Jira Cloud site that allows anonymous reads. Needs the network
// and a browser: npx playwright-core install chromium (or set TABKIT_CHROME to a binary).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const site = process.env.TABKIT_E2E_SITE || "https://hibernate.atlassian.net";
const jql = process.env.TABKIT_E2E_JQL || "project = HHH ORDER BY created DESC";
const token = crypto.randomBytes(24).toString("base64url");
const port = "17381";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tabkit-e2e-"));

const client = new Client({ name: "tabkit-e2e", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "index.js")],
  env: { ...process.env, TABKIT_PAIRING_TOKEN: token, TABKIT_PORTS: port },
  stderr: "inherit"
}));

const browser = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.TABKIT_CHROME || chromium.executablePath(),
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});

const text = (result) => result.content.map((part) => part.text).join("\n");

try {
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent("serviceworker", { timeout: 15_000 });
  // What the popup's Save button does.
  await worker.evaluate((settings) => chrome.storage.local.set(settings), { site, token, ports: port });

  const whoami = await client.callTool({ name: "atlassian_whoami", arguments: {} });
  assert.match(text(whoami), /401|accountId/, text(whoami));
  console.log(`atlassian_whoami: ${whoami.isError ? "401, not logged in (expected for a fresh profile)" : "logged in"}`);

  const search = await client.callTool({
    name: "jira_search_issues",
    arguments: { jql, maxResults: 2, fields: ["summary"], defaultFields: false }
  });
  assert.equal(search.isError, undefined, text(search));
  const keys = JSON.parse(text(search)).issues.map((issue) => issue.key);
  assert.ok(keys.length > 0, "no issues returned");
  console.log(`jira_search_issues: ${keys.join(", ")}`);

  const issue = await client.callTool({ name: "jira_get_issue", arguments: { issueKey: keys[0], fields: ["summary"] } });
  assert.equal(issue.isError, undefined, text(issue));
  console.log(`jira_get_issue: ${keys[0]} ${JSON.parse(text(issue)).fields.summary}`);

  console.log(`\nOK in ${browser.browser()?.version() ?? "Chrome for Testing"} against ${site}`);
} finally {
  await browser.close();
  await client.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
