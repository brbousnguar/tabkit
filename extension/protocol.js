// Shared by the MCP server (Node) and the Chrome extension: both have WebCrypto as globalThis.crypto.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT_RANGE = "17321-17330";

const encoder = new TextEncoder();

export function parsePortRange(value = DEFAULT_PORT_RANGE) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value).trim());
  const first = Number(match?.[1]);
  const last = Number(match?.[2] ?? match?.[1]);
  if (!match || first < 1024 || last > 65535 || last < first || last - first > 50) {
    throw new Error(`Invalid port range "${value}", expected e.g. ${DEFAULT_PORT_RANGE}`);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export function newNonce() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// HMAC-SHA256 of "<role>:<nonce>" keyed with the pairing token. Each side proves it holds the
// token without sending it, so whoever answers on a port learns nothing it can reuse.
export async function proof(token, role, nonce) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(token, "sign"), encoder.encode(`${role}:${nonce}`));
  return toHex(new Uint8Array(signature));
}

export async function verifyProof(token, role, nonce, candidate) {
  const bytes = fromHex(candidate);
  if (!token || !bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(token, "verify"), bytes, encoder.encode(`${role}:${nonce}`));
}

function hmacKey(token, usage) {
  return crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/.test(value)) return null;
  return new Uint8Array(value.match(/../g).map((pair) => parseInt(pair, 16)));
}
