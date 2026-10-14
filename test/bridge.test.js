import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionBridge } from "../src/bridge.js";
import { TOKEN, connectFakeExtension, jsonResult } from "./fake-extension.js";

function newBridge(ports, options = {}) {
  return new ExtensionBridge({ token: TOKEN, ports, connectTimeoutMs: 300, requestTimeoutMs: 1000, ...options });
}

test("pairs with the extension and relays a request", async (t) => {
  const bridge = newBridge([17391]);
  t.after(() => bridge.close());
  const port = await bridge.listen();

  const extension = await connectFakeExtension(port, {
    reply: (request) => jsonResult(200, { path: request.path, method: request.method, body: request.body })
  });
  assert.equal(extension.ready, true);
  assert.equal(extension.serverProved, true);
  assert.equal(bridge.extension.site, "https://example.atlassian.net");

  const response = await bridge.request("POST", "/rest/api/3/search/jql", { jql: "project = PROJ" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    path: "/rest/api/3/search/jql",
    method: "POST",
    body: JSON.stringify({ jql: "project = PROJ" })
  });
});

test("refuses an extension with another pairing token", async (t) => {
  const bridge = newBridge([17392]);
  t.after(() => bridge.close());
  const port = await bridge.listen();

  const extension = await connectFakeExtension(port, { token: "another-token" });
  assert.equal(extension.ready, false);
  assert.equal(extension.serverProved, false);
  assert.equal(extension.closedWith, 1008);
  assert.equal(bridge.extension, null);
});

test("refuses a connection from a web page", async (t) => {
  const bridge = newBridge([17393]);
  t.after(() => bridge.close());
  const port = await bridge.listen();

  const page = await connectFakeExtension(port, { origin: "https://evil.example" });
  assert.equal(page.ready, false);
  assert.equal(page.closedWith, 1008);
});

test("takes the next free port when one is in use", async (t) => {
  const first = newBridge([17394, 17395]);
  const second = newBridge([17394, 17395]);
  t.after(() => Promise.all([first.close(), second.close()]));

  assert.equal(await first.listen(), 17394);
  assert.equal(await second.listen(), 17395);
  await assert.rejects(newBridge([17394, 17395]).listen(), /Every port of 17394-17395 is taken/);
});

test("says what to check when no extension connects", async (t) => {
  const bridge = newBridge([17396]);
  t.after(() => bridge.close());
  await bridge.listen();

  await assert.rejects(bridge.request("GET", "/rest/api/3/myself"), /did not connect to port 17396/);
});

test("passes on an error the extension reports", async (t) => {
  const bridge = newBridge([17397]);
  t.after(() => bridge.close());
  const port = await bridge.listen();
  await connectFakeExtension(port, { reply: () => ({ error: "Refused: /secure/admin is not a Jira or Confluence REST path" }) });

  await assert.rejects(bridge.request("GET", "/secure/admin"), /Refused: \/secure\/admin/);
});
