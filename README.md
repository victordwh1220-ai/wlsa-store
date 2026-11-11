# WLSA Store

Standalone campus store at `https://wlsa-store.vercel.app`, maintained in its own repository and Vercel project. Athletics links to this site and the store's top logo returns to Athletics.

## Run locally

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/` and `/dashboard`. Set a separate random `STORE_ADMIN_PASSWORD` of at least 32 characters in the shell to test staff access. `PORT` overrides the default port. The loopback server uses the same API handlers with private local files under `.local`. It does not read or write production storage. Files such as `.env`, server source and `.git` are not served.

```sh
npm test
npm run build
```

Only storefront pages, dashboard pages, styles, scripts and approved image/font assets are copied into `dist`. Vercel Functions serve the APIs separately.

## Staff operations

Staff sign in at `/dashboard` using the configured Store staff passphrase. The Reservations section shows customers' pickup requests; Products changes existing product names, yuan prices and listing status. Product photos, categories and allowed sizes come from `catalog.js`.

A reservation starts **pending**. Staff review its items and contact the customer themselves, then enter the pickup time and location before marking it **confirmed**. Move it to **ready** when prepared, and **collected** only after the campus handover. Pending, confirmed or ready reservations can be cancelled. Customer-facing notes are visible to the reservation holder. No automatic email or SMS is sent.

These are requests for campus pickup, with availability and the final amount confirmed on site. There is no online payment, stock allocation or guaranteed inventory. Product images are design visualizations; staff must verify actual availability before confirmation. A stored item/price snapshot preserves each reservation even after catalog edits.

Customers can check the status and cancel an uncollected request through My reservations in the same browser. The browser stores an unguessable access key, not customer names or contact details. Keep the browser data or save the reference to ask staff for assistance. Losing that browser data requires staff assistance; the public reference alone does not reveal customer information. Retrying an interrupted submission uses the same key and does not create a second reservation.

## Production configuration

Connect a **private** Vercel Blob store belonging only to this Store project. Set `BLOB_READ_WRITE_TOKEN` for it, or configure `BLOB_STORE_ID` with Vercel OIDC Blob access. Set a random `STORE_ADMIN_PASSWORD` with at least 32 characters. Keep these values in server-side environment variables and deploy again after changing them. Do not share Athletics' database or credentials. Rotating the Store staff passphrase invalidates existing staff sessions, which otherwise last four hours.

Catalog changes are persisted in `operations/catalog-overrides-v1.json`, and pickup requests in `operations/pickup-reservations-v1.json`. Reservation data is private and available only to authenticated staff or a holder of the corresponding unguessable reservation key. Nothing containing customer information belongs in Git or static build output. Staff should retain customer details only as long as needed to fulfill or resolve a reservation.

This initial campus workflow holds up to 1,000 reservations or 3 MB in its private ledger. Arrange a controlled archive or migrate to paginated database storage before reaching that limit; reaching it stops new submissions instead of discarding existing records. Contact limits allow three open requests and five submissions per day, with a one-minute gap. Separate network limits accommodate shared campus Wi-Fi. The API keeps only a daily keyed network digest, not a raw IP address.

Writes use storage revisions and conditional updates. A stale staff edit returns HTTP 409 instead of overwriting another operator's changes. Staff must reload the current record and review their edit. Public catalog and reservation operations fail closed when storage is unavailable. The base catalog is used only when storage explicitly confirms that no overrides have been saved.

## Deployment

The production alias is `https://wlsa-store.vercel.app`. Publish this repository to its own Vercel project with `npm run build` and output directory `dist`. Do not deploy the Athletics application into this project. Validate storefront submission, staff management and the return link after publication.
