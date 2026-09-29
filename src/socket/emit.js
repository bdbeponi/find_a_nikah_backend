/**
 * The only way anything outside src/socket talks to Socket.IO.
 *
 * Holding the server instance here rather than exporting it from index.js
 * keeps the import graph one-directional: services import this, this imports
 * nothing. Importing the server from a service would close the loop through
 * app.js and leave one of the two halves undefined at load time.
 *
 * Every send is a no-op when the socket server was never started, so the HTTP
 * API works unchanged with realtime switched off - which is what the check
 * script and any script that imports a controller rely on.
 */
let io = null;

export const setIo = (instance) => {
  io = instance;
};

/**
 * One room per user, named by their id, joined on connect. A member with the
 * app open on a phone and a tablet has two sockets in the room and both get it.
 */
export const emitToUser = (userId, event, payload) => {
  io?.to(String(userId)).emit(event, payload);
};

export const emitToUsers = (userIds, event, payload) => {
  for (const id of userIds) emitToUser(id, event, payload);
};

export const isRealtimeUp = () => Boolean(io);
