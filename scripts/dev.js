import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handlers } from "../server/handlers.js";
import { HttpError } from "../server/http.js";
import {
  decodeReservationDocument,
  reservationHandlers,
} from "../server/reservations.js";

const directory = fileURLToPath(new URL("../", import.meta.url));

export function localStorage(file) {
  function read() {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (
        typeof data.etag !== "string" ||
        !data.overrides ||
        typeof data.overrides !== "object"
      )
        throw new Error("Invalid local catalog");
      return data;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { etag: null, overrides: {} };
    }
  }
  return {
    read,
    // The loopback process owns its port-specific file. Keep compare+rename
    // synchronous so requests cannot interleave between the two.
    write(expected, overrides) {
      if (read().etag !== expected)
        throw new HttpError(409, "Another edit was saved. Reload the catalog.");
      const etag = randomUUID();
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const staged = file + "." + etag;
      writeFileSync(staged, JSON.stringify({ etag, overrides }), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(staged, file);
      return etag;
    },
  };
}

const asset = /^\/assets\/(products\/[\w-]+\.webp|fonts\/[\w-]+\.woff2)$/;
const staticFiles = new Set([
  "/index.html",
  "/catalog.js",
  "/store.js",
  "/store.css",
  "/dashboard.html",
  "/dashboard.js",
  "/dashboard.css",
]);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export function localReservationStorage(file) {
  function read() {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (typeof data.etag !== "string")
        throw new Error("Invalid local reservations");
      return {
        etag: data.etag,
        reservations: decodeReservationDocument(
          JSON.stringify({ schema: 1, reservations: data.reservations }),
        ),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { etag: null, reservations: [] };
    }
  }
  return {
    read,
    write(expected, reservations) {
      if (read().etag !== expected)
        throw new HttpError(
          409,
          "Another reservation update was saved. Refresh and review.",
        );
      const etag = randomUUID();
      const body = JSON.stringify({ etag, reservations });
      if (reservations.length > 1000 || Buffer.byteLength(body) > 3_000_000)
        throw new HttpError(
          503,
          "Reservation capacity has been reached. Please contact store staff.",
        );
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const staged = file + "." + etag;
      writeFileSync(staged, body, { flag: "wx", mode: 0o600 });
      renameSync(staged, file);
      return etag;
    },
  };
}

export function createLocalServer(storage, reservationStorage) {
  // Explicit local storage is supplied at startup. Never fall back to production Blob.
  const pickup = reservationHandlers({
    storage: reservationStorage || {
      read() {
        throw new Error("Local reservation storage is not configured.");
      },
    },
    catalogStorage: storage,
    local: true,
  });
  const api = handlers({ storage, local: true });
  const routes = new Map([
    ["/api/catalog", api.publicCatalog],
    ["/api/admin/catalog", api.staffCatalog],
    ["/api/admin/session", api.session],
    ["/api/reservations", pickup.publicReservations],
    ["/api/admin/reservations", pickup.staffReservations],
  ]);
  return createServer(async (req, res) => {
    try {
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "")) {
        res.writeHead(400).end();
        return;
      }
      let pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (routes.has(pathname)) return await routes.get(pathname)(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      if (pathname === "/") pathname = "/index.html";
      if (pathname === "/dashboard" || pathname === "/dashboard/")
        pathname = "/dashboard.html";
      if (!staticFiles.has(pathname) && !asset.test(pathname)) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(directory, pathname.slice(1));
      if ((await realpath(file)) !== file) {
        res.writeHead(404).end();
        return;
      }
      const info = await stat(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)],
        "Content-Length": info.size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") res.end();
      else await pipeline(createReadStream(file), res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end();
    }
  });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const server = createLocalServer(
    localStorage(path.join(directory, ".local", "catalog-" + port + ".json")),
    localReservationStorage(
      path.join(directory, ".local", "reservations-" + port + ".json"),
    ),
  );
  server.listen(port, "127.0.0.1", () =>
    console.log("WLSA Store on http://127.0.0.1:" + port),
  );
}
