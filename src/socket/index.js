import { Server } from "socket.io";
import { User } from "../models/user.model.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { ACCOUNT_STATUS } from "../constants.js";
import { setIo } from "./emit.js";

const readToken = (socket) =>
  socket.handshake.auth?.token ||
  socket.handshake.headers?.authorization?.replace("Bearer ", "");

/**
 * Attaches a realtime layer to the HTTP server.
 *
 * The handshake is authenticated exactly like a request: the id comes out of a
 * signed token and the account is re-read, never out of anything the client
 * sent. A `userId` in handshake.auth would let anybody join anybody's room and
 * read their messages.
 */
export const initSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: (process.env.CORS_ORIGIN || "http://localhost:3002")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = readToken(socket);
      if (!token) return next(new Error("Unauthorized"));

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded._id).select(
        "_id fullName role accountStatus"
      );

      if (!user || user.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
        return next(new Error("Unauthorized"));
      }

      socket.userId = String(user._id);
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(socket.userId);

    // Presence is best-effort and deliberately not stored: a "last seen" that
    // is only as good as the last clean disconnect is worse than none.
    socket.on("typing", ({ conversationId, to }) => {
      if (!to) return;
      io.to(String(to)).emit("typing", {
        conversationId,
        from: socket.userId,
      });
    });

    socket.on("disconnect", () => {
      User.updateOne(
        { _id: socket.userId },
        { $set: { lastActiveAt: new Date() } }
      ).catch(() => {});
    });
  });

  setIo(io);
  return io;
};
