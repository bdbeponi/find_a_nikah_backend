// Keep this first: it populates process.env before any other module is
// evaluated. See the note in loadEnv.js for what breaks otherwise.
import "./config/loadEnv.js";

import { assertEnv } from "./config/env.js";
import { app } from "./app.js";
import connectDB from "./db/index.js";
import { initSocket } from "./socket/index.js";

// Before anything else. A server that boots on placeholder secrets looks
// perfectly healthy and signs tokens anybody can forge.
try {
  assertEnv();
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}

const PORT = process.env.PORT || 8007;

connectDB()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server is running on port:${PORT}`);
    });

    // Chat and notifications ride on the same HTTP server, so there is one
    // port, one TLS certificate and one thing to restart.
    initSocket(server);

    // Without this a deploy restart cuts requests off mid-flight.
    const shutdown = (signal) => {
      console.log(`\n${signal} received, finishing open requests...`);
      server.close(() => {
        console.log("closed cleanly");
        process.exit(0);
      });
      // Nothing legitimate takes 10s; a hung socket must not block the deploy
      setTimeout(() => process.exit(1), 10_000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err) => {
    console.error("❌ Failed to connect to DB:", err);
    process.exit(1);
  });
