# WLSA Store

Standalone frontend for `https://wlsa-store.vercel.app`.

The storefront uses a static catalog and a server-side catalog operations API. Product browsing, category filters, product drawers, image zoom, search, and the local shopping bag run in the browser. Checkout remains ready for the separate store backend to connect later.

## Local preview

```bash
npm run dev
```

Open `http://127.0.0.1:3000/`.

## Catalog operations

Staff use `/dashboard` to change the displayed English and Chinese names, price in yuan, and listing status of existing products. The public catalog reads the current values from a private Vercel Blob store. Edits survive deployments and take effect on the next catalog request. The base photos, SKU IDs, categories and sizes remain in `catalog.js`.

Connect a **private** Vercel Blob store to the Store project's production environment. Set `BLOB_READ_WRITE_TOKEN` for that store, or supply `BLOB_STORE_ID` with the project's Vercel OIDC Blob access. Set `STORE_ADMIN_PASSWORD` to a random staff passphrase of at least 32 characters. Keep these values in server-side environment variables. Use a separate store and passphrase for development. Deploy again after changing environment variables. Rotating the staff passphrase also invalidates all staff sessions. Staff sessions last four hours.

Run `npm ci` and `npm run dev` for a loopback-only preview on port 3000 (override with `PORT`). Set a separate `STORE_ADMIN_PASSWORD` in that shell to test the dashboard. This mode uses the same handlers with a local, port-specific file in `.local` and does not read or write production Blob data. Both the storefront and dashboard work on the same origin. Run `npm ci && npm test` for the API regression checks. Public requests fail with HTTP 503 if storage is unavailable. The server initializes from the base catalog when the private store confirms that no catalog overrides exist.

Two users can edit concurrently. A save with an old catalog revision returns HTTP 409, and the operator must reload before retrying. The only persisted data is product display information in `operations/catalog-overrides-v1.json`. Checkout, payments, stock counts and orders require a separate commerce backend.
