import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOKEN, connectFakeExtension, jsonResult } from "./fake-extension.js";

// Fake Atlassian answers, chosen by the path the server asks the extension to fetch.
function atlassianReply({ method, path, body }) {
  if (path === "/rest/api/3/myself") {
    return jsonResult(200, { accountId: "abc", displayName: "Test User", emailAddress: "test@example.com", timeZone: "Europe/Paris" });
  }
  if (path.startsWith("/rest/api/3/issue/PROJ-1")) return jsonResult(200, { key: "PROJ-1", fields: { summary: "A ticket" } });
  if (path.startsWith("/rest/api/3/issue/")) return jsonResult(401, { errorMessages: ["Client must be authenticated"] });
  if (method === "POST" && path === "/rest/api/3/search/jql") return jsonResult(200, { issues: [], isLast: true, sent: JSON.parse(body) });
  if (path.startsWith("/wiki/rest/api/content/42")) return jsonResult(200, { id: "42", title: "Release notes" });
  return jsonResult(404, { errorMessages: ["unexpected path"] });
}

async function startServer(t, port) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      env: { ...process.env, TABKIT_PAIRING_TOKEN: TOKEN, TABKIT_PORTS: String(port) },
      stderr: "ignore"
    })
  );
  const extension = await connectFakeExtension(port, { reply: atlassianReply });
  t.after(async () => {
    extension.socket.close();
    await client.close();
  });
  return { client, extension };
}

const text = (result) => result.content[0].text;

test("lists the four read tools", async (t) => {
  const { client } = await startServer(t, 17398);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "atlassian_whoami",
    "confluence_get_page",
    "jira_get_issue",
    "jira_search_issues"
  ]);
});

test("runs each tool through the extension", async (t) => {
  const { client, extension } = await startServer(t, 17399);

  const me = JSON.parse(text(await client.callTool({ name: "atlassian_whoami", arguments: {} })));
  assert.equal(me.displayName, "Test User");
  assert.equal(me.site, "https://example.atlassian.net");
  assert.equal(me.bridgePort, 17399);

  const issue = JSON.parse(
    text(await client.callTool({ name: "jira_get_issue", arguments: { issueKey: "PROJ-1", fields: ["summary", "status"] } }))
  );
  assert.equal(issue.fields.summary, "A ticket");
  assert.equal(extension.requests.at(-1).path, "/rest/api/3/issue/PROJ-1?fields=summary%2Cstatus");

  const search = JSON.parse(
    text(
      await client.callTool({
        name: "jira_search_issues",
        arguments: { jql: "project = PROJ", maxResults: 500, fields: ["labels"], defaultFields: false }
      })
    )
  );
  assert.deepEqual(search.sent, { jql: "project = PROJ", maxResults: 100, fields: ["labels"] });

  const page = JSON.parse(text(await client.callTool({ name: "confluence_get_page", arguments: { pageId: "42" } })));
  assert.equal(page.title, "Release notes");
  assert.equal(extension.requests.at(-1).path, "/wiki/rest/api/content/42?expand=body.storage,version,space");
});

test("tells you to log in to Chrome on a 401", async (t) => {
  const { client } = await startServer(t, 17400);
  const result = await client.callTool({ name: "jira_get_issue", arguments: { issueKey: "PROJ-999" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /401\. Not logged in to https:\/\/example\.atlassian\.net in Chrome/);
});
