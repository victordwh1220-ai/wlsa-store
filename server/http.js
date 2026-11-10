import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function endpoint(methods, action) {
  return async function handle(req, res) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (!methods.includes(req.method)) {
        res.setHeader("Allow", methods.join(", "));
        throw new HttpError(405, "Method not allowed.");
      }
      if (req.method !== "GET") checkOrigin(req);
      const result = await action(req, res);
      if (result === undefined) {
        res.statusCode = 204;
        res.end();
      } else {
        respond(res, 200, result);
      }
    } catch (error) {
      if (!(error instanceof HttpError)) {
        console.error("Store catalog request failed.", error?.name);
      }
      respond(res, error instanceof HttpError ? error.status : 503, {
        error:
          error instanceof HttpError
            ? error.message
            : "Catalog service is unavailable.",
      });
    }
  };
}

function respond(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function checkOrigin(req) {
  // A browser cannot forge Origin/Host. Check protocol as well as port.
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(
    req.headers.host || "",
  );
  const scheme = local && !process.env.VERCEL_ENV ? "http" : "https";
  if (
    req.headers.origin !== scheme + "://" + req.headers.host ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    throw new HttpError(403, "Open the dashboard on this store to continue.");
  }
}

export async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    throw new HttpError(415, "Send a JSON request.");
  }
  const limit = 4096;
  if (Number(req.headers["content-length"]) > limit)
    throw new HttpError(413, "Request too large.");
  try {
    // Vercel may already have parsed JSON. Plain Node's IncomingMessage exposes a stream.
    let value = req.body;
    if (value === undefined) {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > limit) throw new HttpError(413, "Request too large.");
        chunks.push(Buffer.from(chunk));
      }
      value = Buffer.concat(chunks).toString("utf8");
    }
    if (typeof value === "string" || Buffer.isBuffer(value))
      value = JSON.parse(value);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    if (Buffer.byteLength(JSON.stringify(value)) > limit)
      throw new HttpError(413, "Request too large.");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON object.");
  }
}

const lifetime = 4 * 3600;
const cookieName = (local) =>
  local ? "wlsa-store-local-staff" : "__Host-wlsa-store-staff";

export function adminSecret() {
  const secret = process.env.STORE_ADMIN_PASSWORD;
  if (!secret || secret.length < 32)
    throw new HttpError(503, "Staff access is not configured.");
  return secret;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function checkPassword(password, secret) {
  return (
    typeof password === "string" &&
    timingSafeEqual(digest(password), digest(secret))
  );
}

function signature(value, secret) {
  return createHmac("sha256", secret)
    .update("wlsa-store-session/v1/" + value)
    .digest("base64url");
}

export function sessionCookie(secret, local = false) {
  const value =
    Math.floor(Date.now() / 1000 + lifetime) +
    "." +
    randomBytes(18).toString("base64url");
  return cookie(value + "." + signature(value, secret), lifetime, local);
}

function cookie(value, ttl, local) {
  return (
    cookieName(local) +
    "=" +
    value +
    "; Path=/; HttpOnly; " +
    (local ? "" : "Secure; ") +
    "SameSite=Strict; Max-Age=" +
    ttl
  );
}

export const expiredCookie = (local = false) => cookie("", 0, local);

export function requireStaff(req, local = false) {
  const secret = adminSecret();
  const name = cookieName(local);
  const entry = (req.headers.cookie || "")
    .split(/;\s*/)
    .find((item) => item.startsWith(name + "="));
  const token = entry?.slice(name.length + 1) || "";
  const parts = /^(\d{10})\.([a-zA-Z0-9_-]{24})\.([a-zA-Z0-9_-]{43})$/.exec(
    token,
  );
  if (
    !parts ||
    Number(parts[1]) <= Date.now() / 1000 ||
    !timingSafeEqual(
      Buffer.from(parts[3]),
      Buffer.from(signature(parts[1] + "." + parts[2], secret)),
    )
  ) {
    throw new HttpError(401, "Staff sign-in required.");
  }
}
