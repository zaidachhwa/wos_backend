import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let io = null;

export const initIO = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN, credentials: true },
  });
  io.use((socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth?.token, process.env.ACCESS_TOKEN_SECRET);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", (socket) => {
    socket.join(`user:${socket.userId}`);
  });
};

export const emitTo = (userId, event, payload) => {
  io?.to(`user:${String(userId)}`).emit(event, payload ?? {});
};

// ponytail: org-wide broadcast; move to per-project rooms if org size makes it matter.
export const broadcast = (event, payload) => {
  io?.emit(event, payload ?? {});
};
