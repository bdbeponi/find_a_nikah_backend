import dotenv from "dotenv";

// Must be the FIRST import of the entry point.
//
// ES module imports are hoisted: every `import` in index.js is evaluated before
// a single line of its body runs. So calling dotenv.config() in that body is
// too late for any module that reads process.env while it is being evaluated —
// app.js builds its CORS allowlist from process.env and would always get
// `undefined`, silently falling back to the hardcoded localhost origin. In
// production that means the real site is blocked by the browser on every API
// call, and nothing in the logs says why.
//
// Importing this module first gives every other module a populated process.env.
dotenv.config();
