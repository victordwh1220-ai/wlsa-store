import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { HttpError } from "./http.js";

// Parse the existing storefront catalog as data. Never evaluate a script.
const source = readFileSync(new URL("../catalog.js", import.meta.url), "utf8");
const match = /^window\.storeCatalog\s*=\s*(\{[\s\S]*\});\s*$/.exec(source);
if (!match) throw new Error("Invalid base catalog.");
const base = JSON.parse(match[1]).products;
const baseRevision = createHash("sha256").update(source).digest("hex");
const path = "operations/catalog-overrides-v1.json";
const editable = ["name", "name_en", "price", "listed"];

export function requireStorage() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new HttpError(503, "Catalog storage is not configured.");
  }
}

function validName(name) {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= 120 &&
    !/[\u0000-\u001f\u007f<>]/u.test(name)
  );
}

function validFields(value) {
  if (
    !value ||
    !validName(value.name) ||
    !validName(value.name_en) ||
    typeof value.listed !== "boolean" ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    value.price > 1000000
  )
    return false;
  return Number(value.price.toFixed(2)) === value.price;
}

export const blobStorage = {
  async read() {
    requireStorage();
    const blob = await get(path, {
      access: "private",
      useCache: false,
      abortSignal: AbortSignal.timeout(8000),
    });
    if (!blob) return { etag: null, overrides: {} };
    if (!blob.blob.etag || blob.statusCode !== 200)
      throw new Error("Invalid catalog response.");
    const document = await new Response(blob.stream).json();
    if (
      document?.schema !== 1 ||
      !document.overrides ||
      Array.isArray(document.overrides) ||
      typeof document.overrides !== "object" ||
      Object.values(document.overrides).some((record) => !validFields(record))
    ) {
      throw new Error("Invalid saved catalog.");
    }
    return { etag: normalizeEtag(blob.blob.etag), overrides: document.overrides };
  },
  async write(etag, overrides) {
    try {
      const result = await put(path, JSON.stringify({ schema: 1, overrides }), {
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
      // During the first save two requests can both observe a missing object.
      // A create-only failure is a conflict only if another version now exists.
      if (etag === null && (await this.read()).etag !== null) throw conflict();
      throw error;
    }
  },
};

// Blob GET can return a weak validator (`W/"…"`) while conditional PUT
// expects the underlying quoted validator (`"…"`). Store one canonical form.
function normalizeEtag(etag) {
  return etag.replace(/^W\//, "");
}

function conflict() {
  return new HttpError(
    409,
    "Another edit was saved. Reload the catalog and review your changes.",
  );
}

function snapshot({ etag, overrides }) {
  const blobRevision = etag?.replace(/^"|"$/g, "") ?? "initial";
  return {
    revision: baseRevision + "." + blobRevision,
    products: base.map(({ id, name, name_en, price }) => {
      const edit = overrides[id];
      return edit
        ? {
            id,
            name: edit.name,
            name_en: edit.name_en,
            price: edit.price,
            listed: edit.listed,
          }
        : { id, name, name_en, price, listed: true };
    }),
  };
}

export async function readCatalog(publicOnly, storage = blobStorage) {
  const state = snapshot(await storage.read());
  if (publicOnly)
    state.products = state.products.filter((product) => product.listed);
  return state;
}

export async function editProduct(input, storage = blobStorage) {
  if (
    !validFields(input) ||
    typeof input.id !== "string" ||
    typeof input.revision !== "string" ||
    Object.keys(input).some(
      (field) => !["id", "revision", ...editable].includes(field),
    )
  ) {
    throw new HttpError(
      400,
      "Enter both names, a valid price in yuan and a listing status.",
    );
  }
  if (!base.some((product) => product.id === input.id))
    throw new HttpError(404, "Product not found.");
  const prior = await storage.read();
  if (input.revision !== snapshot(prior).revision) throw conflict();
  const overrides = {
    ...prior.overrides,
    [input.id]: {
      name: input.name.trim(),
      name_en: input.name_en.trim(),
      price: input.price,
      listed: input.listed,
    },
  };
  const etag = await storage.write(prior.etag, overrides);
  return snapshot({ etag, overrides });
}
