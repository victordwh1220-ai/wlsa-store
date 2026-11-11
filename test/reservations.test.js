import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createReservation,
  decodeReservationDocument,
  customerReservation,
  editReservation,
  readReservations,
  reservationNetworkHash,
} from "../server/reservations.js";
import { editProduct, readCatalog } from "../server/catalog.js";
import { HttpError } from "../server/http.js";
import {
  createLocalServer,
  localStorage,
  localReservationStorage,
} from "../scripts/dev.js";

const key = () => randomBytes(32).toString("base64url");
const input = (overrides = {}) => ({
  action: "create",
  key: key(),
  customer: {
    name: "Test student",
    contact: "student@example.test",
    className: "G11",
  },
  items: [
    { productId: "WLSA-001", size: "M", quantity: 2, expectedUnitPrice: 168 },
  ],
  note: "Please confirm pickup.",
  ...overrides,
});
function memory(field) {
  let state = { etag: null, [field]: field === "reservations" ? [] : {} },
    version = 0;
  return {
    async read() {
      return structuredClone(state);
    },
    async write(expected, data) {
      if (expected !== state.etag) throw new HttpError(409, "Conflict");
      state = { etag: "v" + ++version, [field]: structuredClone(data) };
      return state.etag;
    },
  };
}

test("a pickup reservation snapshots server prices and details; secret key and customer data stay out of public receipts", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides");
  const body = input();
  const { reservation } = await createReservation(body, storage, catalog);
  assert.equal(reservation.status, "pending");
  assert.equal(reservation.total, 336);
  assert.equal(reservation.items[0].unitPrice, 168);
  assert.deepEqual(reservation.pickup, { time: "", place: "" });
  assert.match(reservation.reference, /^WLSA-[A-F0-9]{12}$/);
  for (const field of [
    "customer",
    "key",
    "keyHash",
    "requestHash",
    "note",
    "history",
  ])
    assert.equal(reservation[field], undefined, field);
  assert.equal(JSON.stringify(await storage.read()).includes(body.key), false);
  const staff = await readReservations(storage);
  assert.deepEqual(staff.reservations[0].customer, body.customer);
  assert.equal(staff.reservations[0].note, body.note);
  assert.equal(staff.reservations[0].keyHash, undefined);
  const original = await readCatalog(false, catalog);
  await editProduct(
    {
      ...original.products[0],
      revision: original.revision,
      price: 999,
      listed: false,
    },
    catalog,
  );
  assert.deepEqual(await createReservation(body, storage, catalog), {
    reservation,
  });
  assert.equal(
    (await customerReservation({ action: "lookup", key: body.key }, storage))
      .reservation.total,
    336,
  );
  await assert.rejects(
    createReservation({ ...body, note: "Changed request" }, storage, catalog),
    { status: 409 },
  );
  await assert.rejects(
    customerReservation({ action: "lookup", key: key() }, storage),
    { status: 404 },
  );
});

test("quantity, size, key, contact, field whitelist and displayed estimates are validated", async () => {
  for (const change of [
    { key: "short" },
    { customer: { name: "", contact: "student@example.test" } },
    { customer: { name: "<script>", contact: "student@example.test" } },
    { customer: { name: "Student", contact: "no-contact" } },
    { customer: { name: "Student", contact: "-------" } },
    {
      customer: {
        name: "Student",
        contact: "student@example.test",
        unauthorized: true,
      },
    },
    { items: [] },
    { items: [{ productId: "missing", size: "M", quantity: 1 }] },
    { items: [{ productId: "WLSA-001", size: "fake", quantity: 1 }] },
    { items: [{ productId: "WLSA-001", size: "M", quantity: 0 }] },
    { items: [{ productId: "WLSA-001", size: "M", quantity: 11 }] },
    { items: [{ productId: "WLSA-001", size: "M", quantity: 1.5 }] },
    {
      items: [{ productId: "WLSA-001", size: "M", quantity: 1, unitPrice: 0 }],
    },
    {
      items: [
        { productId: "WLSA-001", size: "M", quantity: 1 },
        { productId: "WLSA-001", size: "M", quantity: 1 },
      ],
    },
    {
      items: ["XS", "S", "M", "L", "XL", "XXL"].map((size) => ({
        productId: "WLSA-001",
        size,
        quantity: 10,
      })),
    },
    { note: "a".repeat(301) },
    { total: 0 },
  ]) {
    const storage = memory("reservations");
    await assert.rejects(
      createReservation(input(change), storage, memory("overrides")),
      { status: 400 },
    );
    assert.equal((await readReservations(storage)).reservations.length, 0);
  }
  const storage = memory("reservations"),
    catalog = memory("overrides");
  await assert.rejects(
    createReservation(
      input({
        items: [
          {
            productId: "WLSA-001",
            size: "M",
            quantity: 1,
            expectedUnitPrice: 1,
          },
        ],
      }),
      storage,
      catalog,
    ),
    { status: 409 },
  );
  const original = await readCatalog(false, catalog);
  await editProduct(
    { ...original.products[0], listed: false, revision: original.revision },
    catalog,
  );
  await assert.rejects(createReservation(input(), storage, catalog), {
    status: 409,
  });
});

test("simultaneous submits with one key are idempotent; unrelated creates cannot overwrite each other", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides");
  const body = input();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => createReservation(body, storage, catalog)),
  );
  assert.ok(
    results.every(
      (result) => result.reservation.id === results[0].reservation.id,
    ),
  );
  assert.equal((await readReservations(storage)).reservations.length, 1);
  await Promise.all(
    ["one@example.test", "two@example.test"].map((contact) =>
      createReservation(
        input({ customer: { name: "Student", contact } }),
        storage,
        catalog,
      ),
    ),
  );
  assert.equal((await readReservations(storage)).reservations.length, 3);
});

test("confirmation needs pickup details, transitions are sequential, terminal records and stale revisions cannot be rewritten", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides"),
    body = input();
  const created = (await createReservation(body, storage, catalog)).reservation;
  let state = await readReservations(storage);
  const patch = {
    revision: state.revision,
    id: created.id,
    status: "confirmed",
    pickup: { time: "", place: "" },
    staffNote: "Ready to arrange",
  };
  await assert.rejects(editReservation(patch, storage), { status: 400 });
  const pickup = {
    time: "2026-11-12 12:00–13:00 (Shanghai)",
    place: "School office",
  };
  await assert.rejects(
    editReservation({ ...patch, pickup, status: "collected" }, storage),
    { status: 409 },
  );
  state = await editReservation({ ...patch, pickup }, storage);
  await assert.rejects(editReservation({ ...patch, pickup }, storage), {
    status: 409,
  });
  state = await editReservation(
    {
      ...patch,
      pickup,
      revision: state.revision,
      staffNote: "Please bring your reference",
    },
    storage,
  );
  assert.equal(state.reservations[0].status, "confirmed");
  const receipt = await customerReservation(
    { action: "lookup", key: body.key },
    storage,
  );
  assert.equal(receipt.reservation.staffNote, "Please bring your reference");
  state = await editReservation(
    { ...patch, pickup, revision: state.revision, status: "ready" },
    storage,
  );
  state = await editReservation(
    { ...patch, pickup, revision: state.revision, status: "collected" },
    storage,
  );
  assert.equal(state.reservations[0].history.length, 5);
  await assert.rejects(
    editReservation(
      { ...patch, pickup, revision: state.revision, status: "cancelled" },
      storage,
    ),
    { status: 409 },
  );
  await assert.rejects(
    customerReservation({ action: "cancel", key: body.key }, storage),
    { status: 409 },
  );
});

test("customer cancellation is persistent and idempotent; staff cannot confirm a concurrently cancelled request", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides"),
    body = input();
  const created = (await createReservation(body, storage, catalog)).reservation;
  const stale = await readReservations(storage);
  const cancelled = await customerReservation(
    { action: "cancel", key: body.key },
    storage,
  );
  assert.equal(cancelled.reservation.status, "cancelled");
  assert.deepEqual(
    await customerReservation({ action: "cancel", key: body.key }, storage),
    cancelled,
  );
  await assert.rejects(
    editReservation(
      {
        revision: stale.revision,
        id: created.id,
        status: "confirmed",
        pickup: { time: "Noon", place: "Office" },
      },
      storage,
    ),
    { status: 409 },
  );
});

test("contact cooldown and open-reservation limits persist across requests", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides");
  const start = Date.parse("2026-11-11T10:00:00Z");
  await createReservation(input(), storage, catalog, new Date(start));
  await assert.rejects(
    createReservation(input(), storage, catalog, new Date(start + 1000)),
    { status: 429 },
  );
  for (let n = 1; n < 3; n++)
    await createReservation(
      input(),
      storage,
      catalog,
      new Date(start + n * 61_000),
    );
  await assert.rejects(
    createReservation(input(), storage, catalog, new Date(start + 4 * 61_000)),
    { status: 429 },
  );
});

test("a ledger or catalog outage never reports a successful reservation", async () => {
  const failed = {
    read() {
      throw new Error("Outage");
    },
  };
  await assert.rejects(
    createReservation(input(), failed, memory("overrides")),
    /Outage/,
  );
  await assert.rejects(
    createReservation(input(), memory("reservations"), failed),
    /Outage/,
  );
  const storage = {
    read: async () => ({ etag: null, reservations: [] }),
    write() {
      throw new Error("Outage");
    },
  };
  await assert.rejects(
    createReservation(input(), storage, memory("overrides")),
    /Outage/,
  );
});

test("local reservation HTTP workflow persists privately and requires origin/authentication", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wlsa-reservations-"));
  const file = path.join(dir, "reservations.json");
  const server = createLocalServer(
    localStorage(path.join(dir, "catalog.json")),
    localReservationStorage(file),
  );
  const previousSecret = process.env.STORE_ADMIN_PASSWORD,
    previousEnvironment = process.env.VERCEL_ENV;
  process.env.STORE_ADMIN_PASSWORD =
    "test-reservations-secret:" + "abcd".repeat(8);
  delete process.env.VERCEL_ENV;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const publicUrl = origin + "/api/reservations",
    staffUrl = origin + "/api/admin/reservations";
  const headers = { origin, "content-type": "application/json" };
  const post = (value, extra = {}) =>
    fetch(publicUrl, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await fetch(publicUrl)).status, 405);
    assert.equal((await fetch(staffUrl)).status, 401);
    assert.equal(
      (await fetch(staffUrl, { method: "PATCH", headers, body: "{}" })).status,
      401,
    );
    assert.equal(
      (await post(input(), { origin: "https://evil.test" })).status,
      403,
    );
    assert.equal(
      (await post(input(), { "sec-fetch-site": "cross-site" })).status,
      403,
    );
    const body = input();
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const receipt = (await response.json()).reservation;
    assert.equal((await post({ action: "lookup", key: key() })).status, 404);
    assert.equal(
      (await localReservationStorage(file).read()).reservations[0].id,
      receipt.id,
    );
    assert.equal((await readFile(file, "utf8")).includes(body.key), false);
    const login = await fetch(origin + "/api/admin/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: process.env.STORE_ADMIN_PASSWORD }),
    });
    const staffHeaders = {
      ...headers,
      cookie: login.headers.get("set-cookie").split(";")[0],
    };
    const state = await (
      await fetch(staffUrl, { headers: staffHeaders })
    ).json();
    assert.equal(state.reservations[0].customer.contact, body.customer.contact);
    const patch = {
      revision: state.revision,
      id: receipt.id,
      status: "confirmed",
      pickup: { time: "Noon", place: "School office" },
      staffNote: "Bring your reference",
    };
    assert.equal(
      (
        await fetch(staffUrl, {
          method: "PATCH",
          headers: { ...staffHeaders, origin: "https://evil.test" },
          body: JSON.stringify(patch),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(staffUrl, {
          method: "PATCH",
          headers: staffHeaders,
          body: JSON.stringify(patch),
        })
      ).status,
      200,
    );
    const confirmed = (
      await (await post({ action: "lookup", key: body.key })).json()
    ).reservation;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.pickup.place, "School office");
    assert.equal((await post({ action: "cancel", key: body.key })).status, 200);
    assert.equal(
      (
        await post({
          action: "create",
          key: key(),
          customer: { name: "a".repeat(5000) },
        })
      ).status,
      413,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.STORE_ADMIN_PASSWORD;
    else process.env.STORE_ADMIN_PASSWORD = previousSecret;
    if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
  }
});

test("network limits cannot be bypassed by switching contact details; hashes reveal no IP or stable cross-day identity", async () => {
  const previousSecret = process.env.STORE_ADMIN_PASSWORD,
    previousEnvironment = process.env.VERCEL_ENV;
  process.env.STORE_ADMIN_PASSWORD = "network-test-secret:" + "a".repeat(32);
  process.env.VERCEL_ENV = "production";
  try {
    const now = new Date("2026-11-11T10:00:00Z");
    const req = {
      headers: {
        "x-vercel-forwarded-for": "192.0.2.5",
        "x-forwarded-for": "198.51.100.7",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const network = reservationNetworkHash(req, false, now);
    assert.match(network, /^[a-f0-9]{64}$/);
    assert.notEqual(
      network,
      reservationNetworkHash(req, false, new Date("2026-11-12T10:00:00Z")),
    );
    assert.equal(
      network,
      reservationNetworkHash(
        {
          ...req,
          headers: { ...req.headers, "x-forwarded-for": "203.0.113.1" },
        },
        false,
        now,
      ),
    );
    assert.notEqual(network, reservationNetworkHash(req, true, now));
    assert.throws(
      () =>
        reservationNetworkHash(
          { headers: { "x-forwarded-for": "192.0.2.5" } },
          false,
          now,
        ),
      { status: 503 },
    );
    assert.throws(
      () =>
        reservationNetworkHash(
          { headers: { "x-vercel-forwarded-for": "invalid" } },
          false,
          now,
        ),
      { status: 503 },
    );
    const storage = memory("reservations"),
      catalog = memory("overrides");
    for (let i = 0; i < 30; i++)
      await createReservation(
        input({
          customer: {
            name: "Student",
            contact: "student" + i + "@example.test",
          },
        }),
        storage,
        catalog,
        now,
        network,
      );
    await assert.rejects(
      createReservation(
        input({
          customer: { name: "Student", contact: "another@example.test" },
        }),
        storage,
        catalog,
        now,
        network,
      ),
      { status: 429 },
    );
    const safe = await readReservations(storage);
    assert.equal(safe.reservations[0].networkHash, undefined);
    assert.equal(
      JSON.stringify(await storage.read()).includes("192.0.2.5"),
      false,
    );
  } finally {
    if (previousSecret === undefined) delete process.env.STORE_ADMIN_PASSWORD;
    else process.env.STORE_ADMIN_PASSWORD = previousSecret;
    if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
  }
});

test("staff updates use compare-and-swap so simultaneous decisions cannot silently overwrite", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides");
  const created = (await createReservation(input(), storage, catalog))
    .reservation;
  const state = await readReservations(storage);
  const patch = {
    revision: state.revision,
    id: created.id,
    pickup: { time: "Noon", place: "School office" },
    staffNote: "Line one\nLine two",
  };
  const results = await Promise.allSettled([
    editReservation({ ...patch, status: "confirmed" }, storage),
    editReservation({ ...patch, status: "cancelled" }, storage),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(
    (await readReservations(storage)).reservations[0].staffNote,
    "Line one\nLine two",
  );
});

test("full reservation storage fails closed without discarding earlier records", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides");
  const body = input();
  await createReservation(body, storage, catalog);
  const state = await storage.read();
  const original = state.reservations[0];
  await storage.write(
    state.etag,
    Array.from({ length: 1000 }, (_, index) => ({
      ...original,
      id: "existing-" + index,
      keyHash: "hash-" + index,
      customer: {
        ...original.customer,
        contact: "existing" + index + "@example.test",
      },
    })),
  );
  await assert.rejects(
    createReservation(
      input({ customer: { name: "New", contact: "new@example.test" } }),
      storage,
      catalog,
    ),
    { status: 503 },
  );
  assert.equal((await readReservations(storage)).reservations.length, 1000);
});

test("historical SKU and size snapshots stay readable after catalog changes; corrupt storage fails closed", async () => {
  const storage = memory("reservations"),
    catalog = memory("overrides");
  const body = input();
  await createReservation(body, storage, catalog);
  const historical = (await storage.read()).reservations[0];
  historical.items[0].productId = "RETIRED-CAMPUS-2025";
  historical.items[0].size = "Legacy XXL Tall";
  const encode = (record) =>
    JSON.stringify({ schema: 1, reservations: [record] });
  const decoded = decodeReservationDocument(encode(historical));
  assert.deepEqual(decoded, [historical]);
  const archivedStorage = {
    read: async () => ({
      etag: "archived",
      reservations: decodeReservationDocument(encode(historical)),
    }),
  };
  assert.equal(
    (
      await customerReservation(
        { action: "lookup", key: body.key },
        archivedStorage,
      )
    ).reservation.items[0].size,
    "Legacy XXL Tall",
  );
  assert.equal(
    (await readReservations(archivedStorage)).reservations[0].items[0]
      .productId,
    "RETIRED-CAMPUS-2025",
  );
  await assert.rejects(
    createReservation(
      input({
        items: [
          {
            productId: historical.items[0].productId,
            size: historical.items[0].size,
            quantity: 1,
          },
        ],
      }),
      memory("reservations"),
      catalog,
    ),
    { status: 400 },
  );
  for (const alter of [
    (record) => {
      record.total += 1;
    },
    (record) => {
      record.items[0].name = "<script>unsafe</script>";
    },
    (record) => {
      record.items[0].productId = "<unsafe>";
    },
    (record) => {
      record.items[0].productId = "";
    },
    (record) => {
      record.items[0].size = "bad\u0000size";
    },
    (record) => {
      record.items[0].size = "";
    },
    (record) => {
      record.items[0].unitPrice = -1;
    },
    (record) => {
      record.staffNote = "<iframe>";
    },
  ]) {
    const corrupt = structuredClone(historical);
    alter(corrupt);
    assert.throws(
      () => decodeReservationDocument(encode(corrupt)),
      /Invalid reservation storage/,
    );
  }
  assert.throws(
    () => decodeReservationDocument("bad json"),
    /Invalid reservation storage/,
  );
  assert.throws(
    () => decodeReservationDocument(" ".repeat(3_000_001)),
    /Invalid reservation storage/,
  );
});
