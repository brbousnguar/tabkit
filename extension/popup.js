import { parsePortRange } from "./protocol.js";
import { normalizeSite, readSettings } from "./settings.js";

const field = (id) => document.getElementById(id);

const settings = await readSettings();
field("site").value = settings.site;
field("token").value = settings.token;
field("ports").value = settings.ports;
showStatus((await chrome.storage.session.get("status")).status);

field("save").addEventListener("click", async () => {
  try {
    const site = normalizeSite(field("site").value);
    const ports = field("ports").value.trim();
    parsePortRange(ports);
    await chrome.storage.local.set({ site, token: field("token").value.trim(), ports });
    field("status").textContent = "Saved. Connecting…";
  } catch (error) {
    field("status").textContent = error.message;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.status) showStatus(changes.status.newValue);
});

function showStatus(status = {}) {
  const ports = status.connectedPorts || [];
  field("status").textContent = [
    ports.length
      ? `Connected to ${ports.length} MCP server(s), port ${ports.join(", ")}.`
      : "No MCP server connected. A server that just started is found within 30 seconds.",
    status.lastError ? `Last problem: ${status.lastError}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
