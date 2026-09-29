import Redis from "ioredis";

/**
 * Response cache for the public, read-only endpoints.
 *
 * No REDIS_URL means every function here is a no-op and the app reads MongoDB
 * on every request. Set REDIS_URL and the public reads start coming out of
 * memory instead.
 *
 * Three rules keep it from ever serving the wrong thing:
 *
 *   - GET only, and only 200s go in.
 *   - Never for a request that carries a login. A signed-in member can ask for
 *     things a guest cannot (a moderator can list hidden profiles through the
 *     same endpoint), so a cached copy of their answer must never reach
 *     anybody else.
 *   - Any successful create/update/delete clears the whole cache. The volume
 *     here is tiny and admin writes are rare, so per-key invalidation would be
 *     bookkeeping nobody would keep correct.
 *
 * Redis being down is not an error the user should see: every call is wrapped,
 * a failure just means the request goes to the database as usual.
 */
const PREFIX = "findanikah:cache:";

export const usingCache = Boolean(process.env.REDIS_URL);

let client = null;
let complained = false;

const connect = () => {
  if (!usingCache || client) return client;

  client = new Redis(process.env.REDIS_URL, {
    // A slow cache must not become a slow site: fail fast and fall through to
    // the database rather than queue requests waiting for a reconnect.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  client.on("error", (err) => {
    if (!complained) {
      complained = true;
      console.warn(`⚠️  Redis unavailable (${err.message}) - serving from MongoDB`);
    }
  });
  client.on("ready", () => {
    complained = false;
    console.log("✅ Redis connected - public reads are cached");
  });

  return client;
};

/** Used by the check script to run the logic against a stand-in. */
export const setClient = (stub) => {
  client = stub;
};

const safe = async (run, fallback = null) => {
  if (!usingCache && !client) return fallback;
  try {
    return await run(connect());
  } catch {
    return fallback;
  }
};

const isAuthed = (req) =>
  Boolean(
    req.cookies?.accessToken ||
      req.cookies?.refreshToken ||
      req.headers?.authorization
  );

export const cacheKey = (req) => `${PREFIX}${req.originalUrl}`;

export const shouldCache = (req) => req.method === "GET" && !isAuthed(req);

/**
 * Serves a stored copy when there is one, otherwise records what the handler
 * produces. `ttl` is in seconds and is the longest anything can be stale for
 * if nothing is written in the meantime.
 */
export const cache =
  (ttl = 60) =>
  async (req, res, next) => {
    if ((!usingCache && !client) || !shouldCache(req)) return next();

    const key = cacheKey(req);
    const hit = await safe((c) => c.get(key));

    if (hit) {
      res.set("X-Cache", "HIT");
      return res.type("application/json").send(hit);
    }

    res.set("X-Cache", "MISS");

    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        // Not awaited: the user should not wait on the cache write.
        safe((c) => c.set(key, JSON.stringify(body), "EX", ttl));
      }
      return send(body);
    };

    return next();
  };

/** Drops every cached response. Called after a write; rare by design. */
export const clearCache = async () =>
  safe(async (c) => {
    let cursor = "0";
    do {
      const [next, keys] = await c.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 200);
      cursor = next;
      if (keys.length) await c.unlink(...keys);
    } while (cursor !== "0");
    return true;
  });

/**
 * Anything that changes public data empties the cache, once the write has
 * actually succeeded. Sitting in app.js rather than in each controller means
 * there is no new endpoint that can quietly forget to do it.
 */
export const clearCacheOnWrite = (req, res, next) => {
  if ((!usingCache && !client) || req.method === "GET") return next();

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) clearCache();
  });

  return next();
};
