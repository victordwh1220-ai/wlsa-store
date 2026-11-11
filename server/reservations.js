import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { blobStorage, readCatalog, requireStorage } from "./catalog.js";
import {
  adminSecret,
  endpoint,
  HttpError,
  jsonBody,
  requireStaff,
} from "./http.js";

const source = readFileSync(new URL("../catalog.js", import.meta.url), "utf8");
const products = JSON.parse(
  /^window\.storeCatalog\s*=\s*(\{[\s\S]*\});\s*$/.exec(source)[1],
).products;
const productMap = new Map(products.map((product) => [product.id, product]));
const ledgerPath = "operations/pickup-reservations-v1.json";
const maximumRecords = 1000;
const maximumBytes = 3_000_000;
const statuses = ["pending", "confirmed", "ready", "collected", "cancelled"];
const terminal = new Set(["collected", "cancelled"]);
const transitions = {
  pending: ["pending", "confirmed", "cancelled"],
  confirmed: ["confirmed", "ready", "cancelled"],
  ready: ["ready", "collected", "cancelled"],
  collected: [],
  cancelled: [],
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const conflict = () =>
  new HttpError(
    409,
    "Another reservation update was saved. Refresh and review before saving again.",
  );

function validDocument(document) {
  const plain = (value, limit, multiline = false) =>
    typeof value === "string" &&
    value.length <= limit &&
    !(
      multiline
        ? /[\u0000-\u0009\u000b-\u001f\u007f<>]/u
        : /[\u0000-\u001f\u007f<>]/u
    ).test(value);
  const digest = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const date = (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  if (
    document?.schema !== 1 ||
    !Array.isArray(document.reservations) ||
    document.reservations.length > maximumRecords
  )
    return false;
  const ids = new Set(),
    keys = new Set();
  return document.reservations.every((record) => {
    if (
      !record ||
      typeof record.id !== "string" ||
      ids.has(record.id) ||
      keys.has(record.keyHash) ||
      !/^WLSA-[A-F0-9]{12}$/.test(record.reference) ||
      !digest(record.keyHash) ||
      !digest(record.requestHash) ||
      (record.networkHash !== null &&
        record.networkHash !== undefined &&
        !digest(record.networkHash)) ||
      !statuses.includes(record.status) ||
      !date(record.createdAt) ||
      !date(record.updatedAt) ||
      !record.customer ||
      !plain(record.customer.name, 80) ||
      !plain(record.customer.contact, 120) ||
      !plain(record.customer.className, 40) ||
      !plain(record.note, 300, true) ||
      !record.pickup ||
      !plain(record.pickup.time, 100) ||
      !plain(record.pickup.place, 160) ||
      !plain(record.staffNote, 300, true) ||
      !Array.isArray(record.history) ||
      record.history.length > 50 ||
      !record.history.every(
        (entry) =>
          statuses.includes(entry.status) &&
          date(entry.at) &&
          ["customer", "staff"].includes(entry.by),
      ) ||
      !Array.isArray(record.items) ||
      !record.items.length ||
      record.items.length > 20 ||
      !record.items.every(
        (item) =>
          // Reservations keep their original snapshot when a SKU or size is retired.
          // The current catalog is authoritative only when accepting a new request.
          item &&
          plain(item.productId, 120) &&
          item.productId.trim().length > 0 &&
          plain(item.size, 40) &&
          item.size.trim().length > 0 &&
          plain(item.name, 120) &&
          plain(item.name_en, 120) &&
          Number.isInteger(item.quantity) &&
          item.quantity >= 1 &&
          item.quantity <= 10 &&
          Number.isFinite(item.unitPrice) &&
          item.unitPrice >= 0 &&
          Number(item.unitPrice.toFixed(2)) === item.unitPrice,
      ) ||
      record.items.reduce((total, item) => total + item.quantity, 0) > 50 ||
      !Number.isFinite(record.total) ||
      record.total !==
        record.items.reduce(
          (total, item) =>
            total + Math.round(item.unitPrice * 100) * item.quantity,
          0,
        ) /
          100
    )
      return false;
    ids.add(record.id);
    keys.add(record.keyHash);
    return true;
  });
}

export function decodeReservationDocument(body) {
  try {
    if (typeof body !== "string" || Buffer.byteLength(body) > maximumBytes)
      throw new Error();
    const document = JSON.parse(body);
    if (!validDocument(document)) throw new Error();
    return document.reservations;
  } catch {
    throw new Error("Invalid reservation storage.");
  }
}

export const reservationBlobStorage = {
  async read() {
    requireStorage();
    const blob = await get(ledgerPath, {
      access: "private",
      useCache: false,
      abortSignal: AbortSignal.timeout(8000),
    });
    if (!blob) return { etag: null, reservations: [] };
    if (blob.statusCode !== 200 || !blob.blob.etag)
      throw new Error("Invalid reservation storage response.");
    const reservations = decodeReservationDocument(
      await new Response(blob.stream).text(),
    );
    return { etag: blob.blob.etag, reservations };
  },
  async write(etag, reservations) {
    const body = JSON.stringify({ schema: 1, reservations });
    if (
      reservations.length > maximumRecords ||
      Buffer.byteLength(body) > maximumBytes
    )
      throw new HttpError(
        503,
        "Reservation capacity has been reached. Please contact store staff.",
      );
    try {
      const result = await put(ledgerPath, body, {
        access: "private",
        contentType: "application/json",
        cacheControlMaxAge: 60,
        addRandomSuffix: false,
        allowOverwrite: etag !== null,
        ...(etag === null ? {} : { ifMatch: etag }),
        abortSignal: AbortSignal.timeout(8000),
      });
      return result.etag;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw conflict();
      if (etag === null && (await this.read()).etag !== null) throw conflict();
      throw error;
    }
  },
};

function only(object, fields) {
  return (
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).every((field) => fields.includes(field))
  );
}
function text(value, limit, required = false, multiline = false) {
  if (value === undefined && !required) return "";
  if (multiline && typeof value === "string")
    value = value.replace(/\r\n?/g, "\n");
  const controls = multiline
    ? /[\u0000-\u0009\u000b-\u001f\u007f<>]/u
    : /[\u0000-\u001f\u007f<>]/u;
  if (
    typeof value !== "string" ||
    value.length > limit ||
    controls.test(value) ||
    (required && !value.trim())
  )
    throw new HttpError(400, "Enter valid plain-text reservation details.");
  return value.trim();
}
function keyHash(key) {
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(key) ||
    Buffer.from(key, "base64url").toString("base64url") !== key
  )
    throw new HttpError(400, "A valid private reservation key is required.");
  return hash(key);
}
function publicRecord(record) {
  const {
    id,
    reference,
    status,
    createdAt,
    updatedAt,
    items,
    total,
    pickup,
    staffNote,
  } = record;
  return {
    id,
    reference,
    status,
    createdAt,
    updatedAt,
    items,
    total,
    pickup,
    staffNote,
  };
}
function staffRecord(record) {
  const {
    keyHash: _key,
    requestHash: _request,
    networkHash: _network,
    ...safe
  } = record;
  return safe;
}
function snapshot(state) {
  return {
    revision: state.etag || "initial",
    reservations: state.reservations
      .map(staffRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
function createInput(input) {
  if (
    !only(input, ["action", "key", "customer", "items", "note"]) ||
    !only(input.customer, ["name", "contact", "className"]) ||
    !Array.isArray(input.items) ||
    !input.items.length ||
    input.items.length > 20
  )
    throw new HttpError(
      400,
      "Enter your contact details and select up to 20 product and size combinations.",
    );
  const customer = {
    name: text(input.customer.name, 80, true),
    contact: text(input.customer.contact, 120, true),
    className: text(input.customer.className, 40),
  };
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.contact) &&
    (!/^\+?[\d ()-]{7,24}$/.test(customer.contact) ||
      customer.contact.replace(/\D/g, "").length < 7)
  )
    throw new HttpError(
      400,
      "Enter an email address or phone number for pickup confirmation.",
    );
  const seen = new Set();
  let quantity = 0;
  const items = input.items.map((item) => {
    if (
      !only(item, ["productId", "size", "quantity", "expectedUnitPrice"]) ||
      typeof item.productId !== "string" ||
      typeof item.size !== "string" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10 ||
      (item.expectedUnitPrice !== undefined &&
        (!Number.isFinite(item.expectedUnitPrice) ||
          item.expectedUnitPrice < 0))
    )
      throw new HttpError(
        400,
        "Select a valid product, size and quantity from 1 to 10.",
      );
    const product = productMap.get(item.productId);
    if (!product || !product.sizes.includes(item.size))
      throw new HttpError(
        400,
        "A product or size is not available. Review your bag.",
      );
    const combination = item.productId + "/" + item.size;
    if (seen.has(combination))
      throw new HttpError(
        400,
        "Combine duplicate product and size rows before submitting.",
      );
    seen.add(combination);
    quantity += item.quantity;
    return {
      productId: item.productId,
      size: item.size,
      quantity: item.quantity,
      ...(item.expectedUnitPrice === undefined
        ? {}
        : { expectedUnitPrice: item.expectedUnitPrice }),
    };
  });
  if (quantity > 50)
    throw new HttpError(400, "A reservation may contain at most 50 items.");
  return { customer, items, note: text(input.note, 300, false, true) };
}

// Vercel supplies this header itself. Never trust forwarded headers in local mode.
// See https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
export function reservationNetworkHash(req, local = false, now = new Date()) {
  const address = local
    ? req.socket?.remoteAddress
    : process.env.VERCEL_ENV
      ? req.headers["x-vercel-forwarded-for"]
      : undefined;
  if (typeof address !== "string" || !isIP(address))
    throw new HttpError(
      503,
      "Reservation request verification is unavailable. Please try again.",
    );
  return createHmac("sha256", adminSecret())
    .update(
      "wlsa-store-network/v1/" +
        now.toISOString().slice(0, 10) +
        "/" +
        address.toLowerCase(),
    )
    .digest("hex");
}
function normalizedContact(contact) {
  return contact.includes("@")
    ? contact.toLowerCase()
    : contact.replace(/[ ()-]/g, "");
}

export async function createReservation(
  input,
  storage = reservationBlobStorage,
  catalogStorage = blobStorage,
  now = new Date(),
  networkHash = null,
) {
  const lookupHash = keyHash(input.key);
  const clean = createInput(input);
  const requestHash = hash(JSON.stringify(clean));
  let state = await storage.read();
  const existing = state.reservations.find(
    (record) => record.keyHash === lookupHash,
  );
  if (existing) {
    if (existing.requestHash !== requestHash)
      throw new HttpError(
        409,
        "This reservation key was already used. View the saved reservation or start a new one.",
      );
    return { reservation: publicRecord(existing) };
  }
  const catalog = await readCatalog(true, catalogStorage);
  const items = clean.items.map((item) => {
    const product = catalog.products.find(
      (candidate) => candidate.id === item.productId,
    );
    if (!product)
      throw new HttpError(
        409,
        "A product is no longer listed. Refresh your bag and review it before reserving.",
      );
    if (
      item.expectedUnitPrice !== undefined &&
      item.expectedUnitPrice !== product.price
    )
      throw new HttpError(
        409,
        "A price has changed. Refresh your bag and review the estimate before reserving.",
      );
    return {
      productId: item.productId,
      name: product.name,
      name_en: product.name_en,
      size: item.size,
      quantity: item.quantity,
      unitPrice: product.price,
    };
  });
  const id = randomUUID();
  const timestamp = now.toISOString();
  const record = {
    id,
    reference: "WLSA-" + id.replaceAll("-", "").slice(0, 12).toUpperCase(),
    keyHash: lookupHash,
    requestHash,
    networkHash,
    status: "pending",
    customer: clean.customer,
    note: clean.note,
    items,
    total:
      items.reduce(
        (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
        0,
      ) / 100,
    pickup: { time: "", place: "" },
    staffNote: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [{ status: "pending", at: timestamp, by: "customer" }],
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const repeated = state.reservations.find(
      (item) => item.keyHash === lookupHash,
    );
    if (repeated) {
      if (repeated.requestHash !== requestHash)
        throw new HttpError(409, "This reservation key was already used.");
      return { reservation: publicRecord(repeated) };
    }
    const sameContact = state.reservations.filter(
      (item) =>
        normalizedContact(item.customer.contact) ===
        normalizedContact(clean.customer.contact),
    );
    if (
      sameContact.some(
        (item) => now.getTime() - Date.parse(item.createdAt) < 60_000,
      ) ||
      sameContact.filter((item) => !terminal.has(item.status)).length >= 3 ||
      sameContact.filter(
        (item) => now.getTime() - Date.parse(item.createdAt) < 86_400_000,
      ).length >= 5
    )
      throw new HttpError(
        429,
        "Please wait before reserving again. You may have up to three open reservations and five per day per contact.",
      );
    const networkRecords = networkHash
      ? state.reservations.filter((item) => item.networkHash === networkHash)
      : [];
    // Campus Wi-Fi may share one public address; permit a reasonable burst.
    if (
      networkRecords.filter(
        (item) => now.getTime() - Date.parse(item.createdAt) < 60_000,
      ).length >= 30 ||
      networkRecords.filter(
        (item) => now.getTime() - Date.parse(item.createdAt) < 3_600_000,
      ).length >= 100 ||
      networkRecords.length >= 300
    )
      throw new HttpError(
        429,
        "Too many reservation requests from this network. Please wait and try again.",
      );
    if (state.reservations.length >= maximumRecords)
      throw new HttpError(
        503,
        "Reservation capacity has been reached. Please contact store staff.",
      );
    try {
      await storage.write(state.etag, [...state.reservations, record]);
      return { reservation: publicRecord(record) };
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        error.status !== 409 ||
        attempt === 3
      )
        throw error;
      state = await storage.read();
    }
  }
}

export async function customerReservation(
  input,
  storage = reservationBlobStorage,
  catalogStorage = blobStorage,
  networkHash = null,
) {
  if (input.action === "create")
    return createReservation(
      input,
      storage,
      catalogStorage,
      new Date(),
      networkHash,
    );
  if (
    !only(input, ["action", "key"]) ||
    !["lookup", "cancel"].includes(input.action)
  )
    throw new HttpError(400, "Choose a valid reservation action.");
  const lookupHash = keyHash(input.key);
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await storage.read();
    const record = state.reservations.find(
      (item) => item.keyHash === lookupHash,
    );
    if (!record)
      throw new HttpError(
        404,
        "Reservation not found. Check your private reservation key.",
      );
    if (input.action === "lookup" || record.status === "cancelled")
      return { reservation: publicRecord(record) };
    if (terminal.has(record.status))
      throw new HttpError(409, "Collected reservations cannot be cancelled.");
    const timestamp = new Date().toISOString();
    const saved = {
      ...record,
      status: "cancelled",
      updatedAt: timestamp,
      history: [
        ...record.history.slice(-49),
        { status: "cancelled", at: timestamp, by: "customer" },
      ],
    };
    try {
      await storage.write(
        state.etag,
        state.reservations.map((item) =>
          item.id === record.id ? saved : item,
        ),
      );
      return { reservation: publicRecord(saved) };
    } catch (error) {
      if (
        !(error instanceof HttpError) ||
        error.status !== 409 ||
        attempt === 3
      )
        throw error;
    }
  }
}

export async function readReservations(storage = reservationBlobStorage) {
  return snapshot(await storage.read());
}
export async function editReservation(input, storage = reservationBlobStorage) {
  if (
    !only(input, ["revision", "id", "status", "pickup", "staffNote"]) ||
    typeof input.revision !== "string" ||
    typeof input.id !== "string" ||
    !statuses.includes(input.status) ||
    !only(input.pickup, ["time", "place"])
  )
    throw new HttpError(
      400,
      "Enter a valid reservation status and pickup details.",
    );
  const pickup = {
    time: text(input.pickup.time, 100),
    place: text(input.pickup.place, 160),
  };
  const staffNote = text(input.staffNote, 300, false, true);
  if (
    ["confirmed", "ready", "collected"].includes(input.status) &&
    (!pickup.time || !pickup.place)
  )
    throw new HttpError(
      400,
      "Confirm the pickup time and place before updating this status.",
    );
  const state = await storage.read();
  if (snapshot(state).revision !== input.revision) throw conflict();
  const record = state.reservations.find((item) => item.id === input.id);
  if (!record) throw new HttpError(404, "Reservation not found.");
  if (!transitions[record.status].includes(input.status))
    throw new HttpError(
      409,
      "That status change is no longer available. Refresh the reservation.",
    );
  const timestamp = new Date().toISOString();
  const saved = {
    ...record,
    pickup,
    staffNote,
    status: input.status,
    updatedAt: timestamp,
    history: [
      ...record.history.slice(-49),
      { status: input.status, at: timestamp, by: "staff" },
    ],
  };
  const reservations = state.reservations.map((item) =>
    item.id === saved.id ? saved : item,
  );
  const etag = await storage.write(state.etag, reservations);
  return snapshot({ etag, reservations });
}

export function reservationHandlers({
  storage = reservationBlobStorage,
  catalogStorage = blobStorage,
  local = false,
} = {}) {
  return {
    publicReservations: endpoint(["POST"], async (req) => {
      const input = await jsonBody(req);
      const networkHash =
        input.action === "create" ? reservationNetworkHash(req, local) : null;
      return customerReservation(input, storage, catalogStorage, networkHash);
    }),
    staffReservations: endpoint(["GET", "PATCH"], async (req) => {
      requireStaff(req, local);
      return req.method === "GET"
        ? readReservations(storage)
        : editReservation(await jsonBody(req), storage);
    }),
  };
}
