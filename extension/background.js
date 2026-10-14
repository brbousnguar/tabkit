import { PROTOCOL_VERSION, newNonce, parsePortRange, proof, verifyProof } from "./protocol.js";
import { normalizeSite, readSettings } from "./settings.js";

const ALLOWED_PATHS = ["/rest/api/3/", "/rest/agile/1.0/", "/wiki/rest/api/", "/wiki/api/v2/"];
// Read-only: GET, plus the search endpoints Jira only offers as POST. Nothing that writes.
const READ_POSTS = new Set(["/rest/api/3/search/jql", "/rest/api/3/search/approximate-count"]);
const KEEPALIVE_MS = 20_000;
const TAB_LOAD_TIMEOUT_MS = 20_000;

// One WebSocket per port in the range: each Claude session runs its own MCP server on the first free port.
const connections = new Map();
let workTabId = null;

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "connect") connectAll();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.site || changes.token || changes.ports)) reconnect();
});

// A message every 20 s keeps the service worker alive while a server is connected (Chrome 116+).
setInterval(() => {
  for (const entry of connections.values()) {
    if (entry.ready) send(entry.socket, { type: "ping" });
  }
}, KEEPALIVE_MS);

start();

function start() {
  // 30 s is the shortest alarm period: a server that just started is found within that time.
  chrome.alarms.create("connect", { periodInMinutes: 0.5 });
  connectAll();
}

async function connectAll() {
  const { site, token, ports } = await readSettings();
  if (!site || !token) {
    await report({ lastError: "Set your Atlassian site and paste the pairing token (npm run pairing-token), then Save." });
    return;
  }
  for (const port of parsePortRange(ports)) {
    if (!connections.has(port)) connect(port);
  }
}

function reconnect() {
  for (const entry of connections.values()) entry.socket.close();
  connections.clear();
  report().then(connectAll);
}

function connect(port) {
  const entry = { socket: new WebSocket(`ws://127.0.0.1:${port}`), nonce: newNonce(), ready: false };
  connections.set(port, entry);
  entry.socket.onopen = () => send(entry.socket, { type: "hello", version: PROTOCOL_VERSION, nonce: entry.nonce });
  entry.socket.onmessage = (event) =>
    onMessage(port, entry, event.data).catch((error) => report({ lastError: error.message }));
  entry.socket.onclose = () => {
    if (connections.get(port) === entry) connections.delete(port);
    if (entry.ready) report();
  };
}

async function onMessage(port, entry, data) {
  const message = JSON.parse(data);
  const { site, token } = await readSettings();

  switch (message.type) {
    case "challenge":
      if (!(await verifyProof(token, "server", entry.nonce, message.proof))) {
        entry.socket.close();
        await report({ lastError: `The server on port ${port} has another pairing token. Copy it again: npm run pairing-token` });
        return;
      }
      send(entry.socket, {
        type: "auth",
        proof: await proof(token, "extension", message.nonce),
        site: normalizeSite(site),
        extensionVersion: chrome.runtime.getManifest().version
      });
      return;
    case "ready":
      entry.ready = true;
      await report({ lastError: null });
      return;
    case "error":
      await report({ lastError: message.message });
      return;
    case "request":
      if (entry.ready) send(entry.socket, await answer(message, normalizeSite(site)));
      return;
  }
}

async function answer({ id, method, path, body }, site) {
  try {
    return { type: "response", id, result: await atlassianFetch(site, method, path, body) };
  } catch (error) {
    return { type: "response", id, error: error.message };
  }
}

async function atlassianFetch(site, method, path, body) {
  const url = new URL(path, site);
  if (url.origin !== site || !ALLOWED_PATHS.some((prefix) => url.pathname.startsWith(prefix))) {
    throw new Error(`Refused: ${path} is not a Jira or Confluence REST path on ${site}`);
  }
  if (method !== "GET" && !(method === "POST" && READ_POSTS.has(url.pathname))) {
    throw new Error(`Refused: ${method} ${url.pathname} (tabkit only reads)`);
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: await workTab(site) },
    func: fetchInPage,
    args: [site, url.pathname + url.search, method, body ?? null]
  });
  const result = injection?.result;
  if (!result) throw new Error("The Jira tab returned nothing: was it closed or reloaded during the request?");
  if (result.error) throw new Error(result.error);
  return result;
}

// Runs inside the Jira tab. A same-origin request, so Chrome sends the session cookie as it does
// for Jira's own pages; the cookie never reaches the extension or the MCP server.
async function fetchInPage(site, path, method, body) {
  if (location.origin !== site) {
    return { error: `The Jira tab is on ${location.origin}, not ${site}: log in to Jira in Chrome, then retry.` };
  }
  try {
    const headers = { Accept: "application/json", "X-Atlassian-Token": "no-check" };
    if (body !== null) headers["Content-Type"] = "application/json";
    const response = await fetch(site + path, { method, headers, body: body ?? undefined, credentials: "same-origin" });
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") || "",
      text: await response.text()
    };
  } catch (error) {
    return { error: `Request failed in the Jira tab: ${error.message}` };
  }
}

// Any open tab on the site works. Without one, open a small JSON page in the background and keep it.
async function workTab(site) {
  if (workTabId !== null) {
    const tab = await chrome.tabs.get(workTabId).catch(() => null);
    if (tab && tabOrigin(tab) === site) return loaded(tab);
    workTabId = null;
  }
  const tabs = await chrome.tabs.query({ url: `${site}/*` });
  const open = tabs.find((tab) => !tab.discarded && tab.status === "complete") ?? tabs[0];
  if (open) {
    workTabId = open.id;
    return loaded(open);
  }
  const created = await chrome.tabs.create({ url: `${site}/rest/api/3/serverInfo`, active: false });
  await chrome.tabs.update(created.id, { autoDiscardable: false });
  workTabId = created.id;
  return loaded(created);
}

async function loaded(tab) {
  if (tab.discarded) await chrome.tabs.reload(tab.id);
  else if (tab.status === "complete") return tab.id;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The Jira tab did not finish loading")), TAB_LOAD_TIMEOUT_MS);
    const listener = (tabId, change) => {
      if (tabId === tab.id && change.status === "complete") finish();
    };
    function finish(error) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    // It may have finished between the first check and the listener.
    chrome.tabs.get(tab.id).then((current) => current.status === "complete" && finish(), finish);
  });
  return tab.id;
}

function tabOrigin(tab) {
  try {
    return new URL(tab.url || tab.pendingUrl).origin;
  } catch {
    return null;
  }
}

async function report(change = {}) {
  const { status = {} } = await chrome.storage.session.get("status");
  const connectedPorts = [...connections].filter(([, entry]) => entry.ready).map(([port]) => port);
  await chrome.storage.session.set({ status: { ...status, ...change, connectedPorts } });
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
