import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION, newNonce, proof, verifyProof } from "../extension/protocol.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;

// The local end of the link to the Chrome extension: a WebSocket server on 127.0.0.1 that only
// accepts a chrome-extension:// origin holding the pairing token, then relays REST requests to it.
export class ExtensionBridge {
  constructor({ token, ports, host = "127.0.0.1", connectTimeoutMs = 35_000, requestTimeoutMs = 60_000, log = () => {} }) {
    this.token = token;
    this.ports = ports;
    this.host = host;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.server = null;
    this.port = null;
    this.listenError = null;
    this.extension = null;
    this.waiters = new Set();
    this.pending = new Map();
    this.nextId = 1;
  }

  async listen() {
    for (const port of this.ports) {
      try {
        this.server = await listenOn(this.host, port, (socket, request) => this.accept(socket, request));
        this.port = port;
        return port;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw (this.listenError = error);
      }
    }
    this.listenError = new Error(
      `Every port of ${this.ports[0]}-${this.ports.at(-1)} is taken by another session running this server. ` +
        "Close one, or widen TABKIT_PORTS and the extension's Ports field."
    );
    throw this.listenError;
  }

  accept(socket, request) {
    const origin = request.headers.origin || "";
    if (!origin.startsWith("chrome-extension://")) {
      socket.close(1008, "Only the Chrome extension may connect");
      return;
    }
    const state = { step: "hello", nonce: newNonce() };
    state.timer = setTimeout(() => socket.close(1008, "Pairing timed out"), HANDSHAKE_TIMEOUT_MS);

    socket.on("message", (data) =>
      this.onMessage(socket, state, data).catch((error) => {
        this.log(`bad message from the extension: ${error.message}`);
        socket.close(1008, "Bad message");
      })
    );
    socket.on("close", () => {
      clearTimeout(state.timer);
      this.failPending(socket, "The Chrome extension disconnected during the request");
      if (this.extension?.socket === socket) this.extension = null;
    });
  }

  async onMessage(socket, state, data) {
    const message = JSON.parse(String(data));

    if (state.step === "hello") {
      if (message.type !== "hello" || typeof message.nonce !== "string") throw new Error("expected hello");
      state.step = "auth";
      send(socket, {
        type: "challenge",
        version: PROTOCOL_VERSION,
        nonce: state.nonce,
        proof: await proof(this.token, "server", message.nonce)
      });
      return;
    }

    if (state.step === "auth") {
      if (message.type !== "auth" || !(await verifyProof(this.token, "extension", state.nonce, message.proof))) {
        send(socket, { type: "error", message: `The pairing token does not match the MCP server on port ${this.port}.` });
        socket.close(1008, "Pairing failed");
        return;
      }
      clearTimeout(state.timer);
      state.step = "ready";
      const previous = this.extension;
      this.extension = { socket, site: message.site, version: message.extensionVersion };
      if (previous) previous.socket.close(1000, "Replaced by a newer connection");
      send(socket, { type: "ready", port: this.port });
      this.log(`Chrome extension paired (site ${message.site})`);
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
      return;
    }

    if (message.type === "ping") {
      send(socket, { type: "pong" });
    } else if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  }

  waitForExtension() {
    if (this.extension) return Promise.resolve(this.extension);
    if (!this.server) return Promise.reject(this.listenError || new Error("The bridge is not listening yet"));

    return new Promise((resolve, reject) => {
      const ready = () => {
        clearTimeout(timer);
        resolve(this.extension);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(ready);
        reject(
          new Error(
            `The Chrome extension did not connect to port ${this.port} within ${Math.round(this.connectTimeoutMs / 1000)} s. ` +
              "Check that Chrome is open, the tabkit extension is loaded, and its popup holds the token " +
              "printed by `npm run pairing-token`."
          )
        );
      }, this.connectTimeoutMs);
      this.waiters.add(ready);
    });
  }

  // Resolves with what the tab's fetch returned: { status, ok, contentType, text }.
  async request(method, path, body) {
    const { socket } = await this.waitForExtension();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No answer from the Chrome extension after ${Math.round(this.requestTimeoutMs / 1000)} s`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket });
      send(socket, { type: "request", id, method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    });
  }

  failPending(socket, reason) {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  async close() {
    for (const client of this.server?.clients || []) client.terminate();
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

function listenOn(host, port, onConnection) {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host, port, maxPayload: 64 * 1024 * 1024 });
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      server.on("error", () => {});
      server.on("connection", onConnection);
      resolve(server);
    });
  });
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
