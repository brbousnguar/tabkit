import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const PAIRING_FILE =
  process.env.TABKIT_PAIRING_FILE || path.join(os.homedir(), ".tabkit", "pairing-token");

// The secret the extension must also hold. Created on first use, readable only by you; every
// server process on this machine reads the same file, so one paste in the popup pairs them all.
export function readPairingToken() {
  const fromEnv = process.env.TABKIT_PAIRING_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const existing = readTokenFile();
  if (existing) return existing;

  fs.mkdirSync(path.dirname(PAIRING_FILE), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(PAIRING_FILE, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another server process created it at the same moment: use that one.
    if (error.code !== "EEXIST") throw error;
  }
  return readTokenFile();
}

function readTokenFile() {
  try {
    return fs.readFileSync(PAIRING_FILE, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
