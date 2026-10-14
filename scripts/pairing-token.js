#!/usr/bin/env node

import { PAIRING_FILE, readPairingToken } from "../src/pairing.js";

console.log(readPairingToken());
console.error(`Stored in ${PAIRING_FILE}. Paste it in the extension popup (Pairing token), then Save.`);
