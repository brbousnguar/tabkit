import { DEFAULT_PORT_RANGE } from "./protocol.js";

export async function readSettings() {
  const stored = await chrome.storage.local.get(["site", "token", "ports"]);
  return {
    site: stored.site || "",
    token: (stored.token || "").trim(),
    ports: stored.ports || DEFAULT_PORT_RANGE
  };
}

// Only *.atlassian.net is in the manifest's host permissions, so only those sites can work.
export function normalizeSite(value) {
  const url = new URL(String(value).trim());
  if (url.protocol !== "https:" || !url.hostname.endsWith(".atlassian.net")) {
    throw new Error("The site must be https://<name>.atlassian.net");
  }
  return url.origin;
}
