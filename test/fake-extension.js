import { WebSocket } from "ws";
import { PROTOCOL_VERSION, newNonce, proof, verifyProof } from "../extension/protocol.js";

export const TOKEN = "test-pairing-token";

// Plays the Chrome extension: pairs with the token, then answers each request with reply(request).
// Resolves once paired ({ ready: true }) or once the server closes the socket ({ closedWith }).
export function connectFakeExtension(port, { token = TOKEN, origin = "chrome-extension://fake", reply = () => ({}) } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const nonce = newNonce();
    const state = { socket, ready: false, serverProved: false, closedWith: null, requests: [] };

    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, nonce })));
    socket.on("message", async (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "challenge") {
        state.serverProved = await verifyProof(token, "server", nonce, message.proof);
        socket.send(
          JSON.stringify({
            type: "auth",
            proof: await proof(token, "extension", message.nonce),
            site: "https://example.atlassian.net",
            extensionVersion: "test"
          })
        );
      } else if (message.type === "ready") {
        state.ready = true;
        resolve(state);
      } else if (message.type === "request") {
        state.requests.push(message);
        socket.send(JSON.stringify({ type: "response", id: message.id, ...(await reply(message)) }));
      }
    });
    socket.on("close", (code) => {
      state.closedWith = code;
      resolve(state);
    });
    socket.on("error", reject);
  });
}

export function jsonResult(status, body) {
  return { result: { status, ok: status >= 200 && status < 300, contentType: "application/json", text: JSON.stringify(body) } };
}
