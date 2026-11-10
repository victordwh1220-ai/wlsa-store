import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLocalServer, localStorage } from "../scripts/dev.js";

test("local staff can edit, delist and relist with persistent data; private files never served", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wlsa-preview-"));
  const file = path.join(dir, "catalog.json");
  const server = createLocalServer(localStorage(file));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const prior = process.env.STORE_ADMIN_PASSWORD;
  const previousEnvironment = process.env.VERCEL_ENV;
  delete process.env.VERCEL_ENV;
  process.env.STORE_ADMIN_PASSWORD = "local-only:" + "abcd".repeat(9);
  try {
    for (const uri of [
      "/.env",
      "/.git/config",
      "/node_modules/@vercel/blob/package.json",
      "/server/http.js",
      "/.local/catalog-3000.json",
      "/%2e%2e/.git/config",
    ]) {
      assert.equal((await fetch(origin + uri)).status, 404, uri);
    }
    assert.equal((await fetch(origin + "/dashboard")).status, 200);
    assert.equal(
      (
        await fetch(
          origin + "/assets/products/001-navy-embroidered-tee-a.webp",
          { method: "HEAD" },
        )
      ).headers.get("content-type"),
      "image/webp",
    );
    assert.equal((await fetch(origin + "/api/admin/catalog")).status, 401);
    const session = await fetch(origin + "/api/admin/session", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.STORE_ADMIN_PASSWORD }),
    });
    assert.equal(session.status, 204);
    const cookie = session.headers.get("set-cookie");
    assert.match(cookie, /^wlsa-store-local-staff=/);
    assert.doesNotMatch(cookie, /; Secure/);
    const headers = {
      origin,
      cookie: cookie.split(";")[0],
      "content-type": "application/json",
    };
    const adminUrl = origin + "/api/admin/catalog";
    const publicUrl = origin + "/api/catalog";
    const initial = await (await fetch(adminUrl, { headers })).json();
    const product = {
      ...initial.products[0],
      revision: initial.revision,
      listed: false,
      price: 33.51,
    };
    const write = (value) =>
      fetch(adminUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify(value),
      });
    const result = await write(product);
    assert.equal(result.status, 200);
    const saved = await result.json();
    assert.equal(localStorage(file).read().overrides[product.id].listed, false);
    assert.ok(
      !(await (await fetch(publicUrl)).json()).products.some(
        (p) => p.id === product.id,
      ),
    );
    assert.equal((await write(product)).status, 409);
    assert.equal(
      (await write({ ...product, revision: saved.revision, listed: true }))
        .status,
      200,
    );
    assert.equal(
      (await (await fetch(publicUrl)).json()).products.find(
        (p) => p.id === product.id,
      ).price,
      33.51,
    );
  } finally {
    if (prior === undefined) delete process.env.STORE_ADMIN_PASSWORD;
    else process.env.STORE_ADMIN_PASSWORD = prior;
    if (previousEnvironment !== undefined)
      process.env.VERCEL_ENV = previousEnvironment;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
