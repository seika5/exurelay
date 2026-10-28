import { io, type Socket } from "socket.io-client";
import { getServerUrl } from "./server";
import { dropSession, getSession } from "./session";

/**
 * Socket.io connection to the relay, authenticated with the login session (the server ties the socket to our
 * keyHash). The session is fetched afresh on every (re)connect. Login failures from the server's middleware
 * don't trigger socket.io's own reconnect, so we retry with a growing delay.
 */
export function createSocket(): Socket {
  const socket = io(getServerUrl(), {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    auth: (cb) => {
      getSession()
        .then((s) => cb({ session: s.token }))
        .catch(() => cb({}));
    },
  });
  let delay = 2000;
  socket.on("connect", () => {
    delay = 2000;
  });
  socket.on("connect_error", () => {
    if (socket.active) return; // transport error: socket.io retries by itself
    dropSession();
    setTimeout(() => socket.connect(), delay);
    delay = Math.min(delay * 2, 60_000);
  });
  return socket;
}
