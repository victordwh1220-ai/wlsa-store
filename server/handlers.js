import {
  adminSecret,
  checkPassword,
  endpoint,
  expiredCookie,
  HttpError,
  jsonBody,
  requireStaff,
  sessionCookie,
} from "./http.js";
import {
  readCatalog,
  editProduct,
  blobStorage,
  requireStorage,
} from "./catalog.js";

// Production Functions use private Blob. The local server supplies a local file
// storage and an HTTP-only loopback cookie, independent of production credentials.
export function handlers({ storage = blobStorage, local = false } = {}) {
  return {
    publicCatalog: endpoint(["GET"], () => readCatalog(true, storage)),
    staffCatalog: endpoint(["GET", "PATCH"], async (req) => {
      requireStaff(req, local);
      return req.method === "GET"
        ? readCatalog(false, storage)
        : editProduct(await jsonBody(req), storage);
    }),
    session: endpoint(["POST", "DELETE"], async (req, res) => {
      if (req.method === "DELETE") {
        res.setHeader("Set-Cookie", expiredCookie(local));
        return;
      }
      if (!local) requireStorage();
      const secret = adminSecret();
      const { password } = await jsonBody(req);
      if (!checkPassword(password, secret))
        throw new HttpError(401, "Incorrect staff password.");
      res.setHeader("Set-Cookie", sessionCookie(secret, local));
    }),
  };
}
