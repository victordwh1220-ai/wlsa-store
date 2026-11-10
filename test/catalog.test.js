import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import sessionApi from "../api/admin/session.js";
import adminApi from "../api/admin/catalog.js";
import { editProduct, readCatalog, requireStorage } from "../server/catalog.js";
import { HttpError, sessionCookie, requireStaff } from "../server/http.js";

function memoryStorage() {
  let current = { etag: null, overrides: {} };
  let count = 0;
  return {
    async read() {
      return current;
    },
    async write(expected, overrides) {
      if (expected !== current.etag) throw new HttpError(409, "Conflict");
      current = { etag: "revision-" + ++count, overrides };
      return current.etag;
    },
  };
}

test("names, cent prices and delisting survive reads and merge with base products", async () => {
  const storage = memoryStorage();
  const initial = await readCatalog(false, storage);
  const original = initial.products[0];
  const saved = await editProduct(
    {
      ...original,
      revision: initial.revision,
      price: 159.95,
      name: "短袖",
      name_en: "Campus tee",
      listed: false,
    },
    storage,
  );
  assert.notEqual(saved.revision, initial.revision);
  assert.equal(saved.products[0].name_en, "Campus tee");
  assert.equal(saved.products[0].name, "短袖");
  assert.equal(saved.products[0].price, 159.95);
  assert.equal(saved.products[0].listed, false);
  assert.deepEqual(initial.products.slice(1), saved.products.slice(1));
  assert.deepEqual(await readCatalog(false, storage), saved);
  assert.equal(
    (await readCatalog(true, storage)).products.find(
      (p) => p.id === original.id,
    ),
    undefined,
  );
  const listed = await editProduct(
    { ...saved.products[0], revision: saved.revision, listed: true },
    storage,
  );
  assert.deepEqual(
    (await readCatalog(true, storage)).products[0],
    listed.products[0],
  );
});

test("concurrent edits from the same first or later revision cannot silently overwrite", async () => {
  const storage = memoryStorage();
  for (let index = 0; index < 2; index++) {
    const { revision, products } = await readCatalog(false, storage);
    const edit = { ...products[0], revision };
    const results = await Promise.allSettled([
      editProduct({ ...edit, price: 1 }, storage),
      editProduct({ ...edit, price: 2 }, storage),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.status,
      409,
    );
    await assert.rejects(editProduct(edit, storage), { status: 409 });
  }
});

test("malformed edits and unknown SKUs cannot change the catalog", async () => {
  const storage = memoryStorage();
  const initial = await readCatalog(false, storage);
  for (const bad of [
    { price: -1 },
    { price: 1.234 },
    { price: "8" },
    { price: null },
    { price: 1000001 },
    { listed: 1 },
    { name: "" },
    { name_en: "<b>X</b>" },
    { images: { a: "/fake" } },
  ]) {
    await assert.rejects(
      editProduct(
        { ...initial.products[0], revision: initial.revision, ...bad },
        storage,
      ),
      { status: 400 },
    );
  }
  await assert.rejects(
    editProduct(
      {
        ...initial.products[0],
        id: "unlisted-sku",
        revision: initial.revision,
      },
      storage,
    ),
    { status: 404 },
  );
  assert.deepEqual(await readCatalog(false, storage), initial);
});

test("storage failure never republishes the base catalog", async () => {
  const storage = {
    read() {
      throw new Error("Storage unavailable");
    },
  };
  await assert.rejects(readCatalog(true, storage), /Storage unavailable/);
});

let server, origin;
const keys = [
  "STORE_ADMIN_PASSWORD",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "VERCEL_ENV",
];
const savedEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
before(async () => {
  for (const k of keys) delete process.env[k];
  process.env.STORE_ADMIN_PASSWORD = "test-only:" + "demo".repeat(9);
  process.env.BLOB_READ_WRITE_TOKEN = "fake-storage-token-for-auth-tests";
  server = createServer((req, res) =>
    (req.url === "/api/admin/session" ? sessionApi : adminApi)(req, res),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const key of keys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("staff sign-in, secure cookie, CSRF, session rotation and logout", async () => {
  const url = origin + "/api/admin/session";
  const submit = (password, source = origin) =>
    fetch(url, {
      method: "POST",
      headers: { origin: source, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  assert.equal((await submit("wrong")).status, 401);
  assert.equal(
    (await submit(process.env.STORE_ADMIN_PASSWORD, "https://other.example"))
      .status,
    403,
  );
  const response = await submit(process.env.STORE_ADMIN_PASSWORD);
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"])
    assert.ok(cookie.includes(flag));
  const request = { headers: { cookie: cookie.split(";")[0] } };
  assert.doesNotThrow(() => requireStaff(request));
  assert.throws(
    () =>
      requireStaff({
        headers: { cookie: request.headers.cookie + "tampered" },
      }),
    { status: 401 },
  );
  const old = process.env.STORE_ADMIN_PASSWORD;
  process.env.STORE_ADMIN_PASSWORD = "rotated:" + old;
  assert.throws(() => requireStaff(request), { status: 401 });
  process.env.STORE_ADMIN_PASSWORD = old;
  const logout = await fetch(url, { method: "DELETE", headers: { origin } });
  assert.equal(logout.status, 204);
  assert.ok(logout.headers.get("set-cookie").includes("Max-Age=0"));
});

test("staff writes require authentication and same-origin intent", async () => {
  const url = origin + "/api/admin/catalog";
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { method: "PATCH", headers: { origin } })).status,
    401,
  );
  const cookie = sessionCookie(process.env.STORE_ADMIN_PASSWORD).split(";")[0];
  assert.equal(
    (
      await fetch(url, {
        method: "PATCH",
        headers: { origin: "https://evil.example", cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "PATCH",
        headers: { origin, cookie },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "PATCH",
        headers: { origin, cookie, "Content-Type": "application/json" },
        body: "x".repeat(5000),
      })
    ).status,
    413,
  );
});

test("credentials must be configured before staff access is possible", async () => {
  const prior = process.env.STORE_ADMIN_PASSWORD;
  delete process.env.STORE_ADMIN_PASSWORD;
  assert.throws(() => requireStaff({ headers: {} }), { status: 503 });
  process.env.STORE_ADMIN_PASSWORD = prior;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  assert.throws(() => requireStorage(), { status: 503 });
  process.env.BLOB_READ_WRITE_TOKEN = token;
});
