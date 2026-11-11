"use strict";

const $ = (selector) => document.querySelector(selector);
const details = new Map(
  window.storeCatalog.products.map((product) => [product.id, product]),
);
const categoryNames = new Map(
  window.storeCatalog.categories.map((category) => [category.id, category.en]),
);
const currency = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "CNY",
});
const dateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});
const statusLabels = {
  pending: "Pending confirmation",
  confirmed: "Confirmed",
  ready: "Ready for pickup",
  collected: "Collected",
  cancelled: "Cancelled",
};
const transitions = {
  pending: ["pending", "confirmed", "cancelled"],
  confirmed: ["confirmed", "ready", "cancelled"],
  ready: ["ready", "collected", "cancelled"],
  collected: ["collected"],
  cancelled: ["cancelled"],
};
const editForm = $("#edit-form");
const dialog = $("#editor");
const reservationDialog = $("#reservation-editor");
const reservationForm = $("#reservation-form");
let catalog;
let reservations;
let editing;
let reservationEditing;
let latestReservation;
let saving = false;
let reservationSaving = false;
let loading = false;
let sessionEpoch = 0;
let activePanel = "reservations";

async function api(endpoint, method = "GET", data) {
  const epoch = sessionEpoch;
  const response = await fetch("/api/admin/" + endpoint, {
    method,
    cache: "no-store",
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result =
    response.status === 204
      ? undefined
      : await response.json().catch(() => ({}));
  if (epoch !== sessionEpoch) {
    const error = new Error("Staff session changed.");
    error.stale = true;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      result?.error || "Store service unavailable. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

function showAccess(message, login) {
  sessionEpoch++;
  dialog.close();
  reservationDialog.close();
  editForm.reset();
  reservationForm.reset();
  catalog =
    reservations =
    editing =
    reservationEditing =
    latestReservation =
      null;
  for (const selector of [
    "#catalog-rows",
    "#reservation-list",
    "#reservation-summary",
    "#reservation-meta",
    "#reservation-customer",
    "#reservation-items",
  ])
    $(selector).replaceChildren();
  for (const selector of [
    "#reservation-customer-note",
    "#reservation-total",
    "#reservation-latest",
    "#reservation-edit-message",
    "#reservation-count",
    "#reservation-updated",
    "#feedback",
    "#dashboard-message",
  ])
    $(selector).textContent = "";
  $("#reservation-search").value = "";
  $("#workspace").hidden = $("#sign-out").hidden = true;
  $("#access").hidden = false;
  $("#access-message").textContent = message;
  $("#login").hidden = !login;
  $("#retry-access").hidden = login;
}

function expired(error) {
  if (error.stale) return true;
  if (error.status === 401) {
    showAccess("Session expired. Sign in to continue.", true);
    $("#login input").focus();
    return true;
  }
  return false;
}

async function load() {
  if (loading) return;
  loading = true;
  const epoch = sessionEpoch;
  $("#refresh-dashboard").disabled = $("#retry-access").disabled = true;
  $("#refresh-dashboard").setAttribute("aria-busy", "true");
  try {
    const results = await Promise.allSettled([
      api("catalog"),
      api("reservations"),
    ]);
    if (epoch !== sessionEpoch) return;
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.some((error) => error.status === 401)) {
      showAccess("", true);
      return;
    }
    if (results[0].status === "fulfilled") catalog = results[0].value;
    if (results[1].status === "fulfilled") {
      reservations = results[1].value;
      $("#reservation-updated").textContent =
        "Updated " + dateTime.format(new Date()) + " · Shanghai";
    }
    if (!catalog && !reservations) {
      showAccess("Store service unavailable. Please try again.", false);
      return;
    }
    $("#access").hidden = true;
    $("#workspace").hidden = $("#sign-out").hidden = false;
    $("#dashboard-message").textContent = errors.length
      ? "Some data could not be refreshed. Any previous data is still shown. " +
        errors.map((error) => error.message).join(" ")
      : "";
    render();
    renderReservations();
  } finally {
    loading = false;
    $("#refresh-dashboard").disabled = $("#retry-access").disabled = false;
    $("#refresh-dashboard").removeAttribute("aria-busy");
  }
}

function matches(product) {
  const query = $("#product-search").value.trim().toLowerCase();
  const category = $("#category-filter").value;
  const visibility = $("#visibility").value;
  return (
    (!category || details.get(product.id)?.category === category) &&
    (!visibility || product.listed === (visibility === "listed")) &&
    [product.name, product.name_en, product.id].some((value) =>
      value.toLowerCase().includes(query),
    )
  );
}
function render() {
  $("#export-csv").disabled = !catalog;
  const body = $("#catalog-rows");
  body.replaceChildren();
  if (!catalog) {
    $("#result-count").textContent =
      "Catalog unavailable. Use Refresh to try again.";
    return;
  }
  const products = catalog.products.filter(matches);
  $("#result-count").textContent =
    products.length + " of " + catalog.products.length + " products";
  for (const product of products) {
    const detail = details.get(product.id);
    const row = body.insertRow();
    const name = row.insertCell();
    name.append(
      element("strong", product.name_en),
      element("small", product.name + " · " + product.id),
    );
    row.insertCell().textContent = categoryNames.get(detail?.category) || "—";
    row.insertCell().textContent = currency.format(product.price);
    const status = row.insertCell();
    status.textContent = product.listed ? "Listed" : "Hidden";
    status.className = product.listed ? "listed" : "muted";
    const edit = element("button", "Edit", "button");
    edit.type = "button";
    edit.setAttribute("aria-label", "Edit " + product.name_en);
    edit.onclick = () => openEditor(product);
    row.insertCell().append(edit);
  }
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}
function statusBadge(status) {
  return element(
    "span",
    statusLabels[status] || status,
    "status-badge status-" + status,
  );
}
function renderReservations() {
  const list = $("#reservation-list");
  const summary = $("#reservation-summary");
  list.replaceChildren();
  summary.replaceChildren();
  $("#reservation-empty").hidden = false;
  if (!reservations) {
    $("#reservation-count").textContent = "";
    $("#reservation-empty").textContent =
      "Reservations unavailable. Use Refresh to try again.";
    return;
  }
  for (const [status, label] of [
    ["pending", "Awaiting confirmation"],
    ["confirmed", "Confirmed"],
    ["ready", "Ready for pickup"],
  ]) {
    const button = element("button", "", "summary-card");
    button.type = "button";
    button.append(
      element(
        "strong",
        String(
          reservations.reservations.filter(
            (reservation) => reservation.status === status,
          ).length,
        ),
      ),
      element("span", label),
    );
    button.setAttribute(
      "aria-pressed",
      String($("#reservation-status-filter").value === status),
    );
    button.onclick = () => {
      $("#reservation-status-filter").value = status;
      renderReservations();
    };
    summary.append(button);
  }
  const query = $("#reservation-search").value.trim().toLowerCase();
  const status = $("#reservation-status-filter").value;
  const filtered = reservations.reservations
    .filter(
      (reservation) =>
        (!status || reservation.status === status) &&
        [
          reservation.reference,
          reservation.customer.name,
          reservation.customer.contact,
          reservation.customer.className || "",
        ].some((value) => value.toLowerCase().includes(query)),
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $("#reservation-count").textContent =
    filtered.length +
    " of " +
    reservations.reservations.length +
    " reservations";
  $("#reservation-empty").hidden = filtered.length > 0;
  $("#reservation-empty").textContent = reservations.reservations.length
    ? "No reservations match these filters."
    : "No reservations yet. New campus pickup requests will appear here.";
  for (const reservation of filtered) {
    const card = element("article", "", "reservation-card");
    const head = element("div", "", "reservation-card-head");
    head.append(
      element("strong", reservation.reference),
      statusBadge(reservation.status),
    );
    const customer = element("div", "", "reservation-card-customer");
    customer.append(
      element("strong", reservation.customer.name),
      element("span", reservation.customer.contact, "muted"),
    );
    if (reservation.customer.className)
      customer.append(element("span", reservation.customer.className, "muted"));
    const items = reservation.items.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    const content = element(
      "p",
      items +
        (items === 1 ? " item" : " items") +
        " · " +
        currency.format(reservation.total) +
        " estimated",
      "reservation-card-items",
    );
    const footer = element("div", "", "reservation-card-footer");
    const view = element("button", "View details", "button");
    view.type = "button";
    view.setAttribute(
      "aria-label",
      "View reservation " + reservation.reference,
    );
    view.onclick = () => openReservation(reservation);
    footer.append(
      element(
        "span",
        formatDate(reservation.createdAt) + " · Shanghai",
        "muted",
      ),
      view,
    );
    card.append(head, customer, content);
    if (reservation.pickup?.time || reservation.pickup?.place)
      card.append(
        element(
          "p",
          [reservation.pickup.time, reservation.pickup.place]
            .filter(Boolean)
            .join(" · "),
          "reservation-card-pickup",
        ),
      );
    card.append(footer);
    list.append(card);
  }
}

function selectPanel(name, focus = false) {
  activePanel = name;
  for (const panel of ["reservations", "products"]) {
    const selected = panel === name;
    $("#" + panel + "-tab").setAttribute("aria-selected", String(selected));
    $("#" + panel + "-tab").tabIndex = selected ? 0 : -1;
    $("#" + panel + "-panel").hidden = !selected;
  }
  if (focus) $("#" + name + "-tab").focus();
}
for (const name of ["reservations", "products"]) {
  $("#" + name + "-tab").onclick = () => selectPanel(name);
  $("#" + name + "-tab").onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      selectPanel(
        event.key === "Home"
          ? "reservations"
          : event.key === "End"
            ? "products"
            : activePanel === "products"
              ? "reservations"
              : "products",
        true,
      );
    }
  };
}

function contactNode(value) {
  const contact = String(value || "");
  if (
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i.test(contact)
  ) {
    const link = element("a", contact);
    link.href = "mailto:" + encodeURIComponent(contact);
    return link;
  }
  if (/^\+?[\d ()-]{7,25}$/.test(contact)) {
    const link = element("a", contact);
    link.href = "tel:" + contact.replace(/[^\d+]/g, "");
    return link;
  }
  return element("span", contact);
}
function renderReservationDetails(reservation) {
  $("#reservation-title").textContent = reservation.reference;
  $("#reservation-meta").replaceChildren(
    statusBadge(reservation.status),
    element(
      "span",
      "Requested " + formatDate(reservation.createdAt) + " · Shanghai",
      "muted",
    ),
  );
  const customer = $("#reservation-customer");
  customer.replaceChildren(
    element("strong", reservation.customer.name),
    contactNode(reservation.customer.contact),
  );
  if (reservation.customer.className)
    customer.append(element("span", reservation.customer.className, "muted"));
  const items = $("#reservation-items");
  items.replaceChildren();
  for (const item of reservation.items) {
    const row = element("div", "", "reservation-item");
    const detail = element("div", "");
    detail.append(
      element("strong", item.name_en || item.name),
      element(
        "small",
        [item.name, item.size || "One size", "Quantity " + item.quantity]
          .filter(Boolean)
          .join(" · "),
        "muted",
      ),
    );
    row.append(
      detail,
      element("span", currency.format(item.unitPrice * item.quantity)),
    );
    items.append(row);
  }
  $("#reservation-total").textContent =
    "Estimated total " +
    currency.format(reservation.total) +
    " · Confirm on site";
  $("#reservation-customer-note").hidden = !reservation.note;
  $("#reservation-customer-note").textContent = reservation.note
    ? "Customer note · " + reservation.note
    : "";
}
function setStatusOptions(reservation, selected = reservation.status) {
  const select = $("#reservation-status");
  select.replaceChildren();
  const allowed = transitions[reservation.status] || [reservation.status];
  for (const status of allowed)
    select.add(new Option(statusLabels[status], status));
  select.value = allowed.includes(selected) ? selected : reservation.status;
  updatePickupRequirements();
}
function updatePickupRequirements() {
  const needsPickup = ["confirmed", "ready", "collected"].includes(
    $("#reservation-status").value,
  );
  reservationForm.elements.pickupTime.required = needsPickup;
  reservationForm.elements.pickupPlace.required = needsPickup;
}
function openReservation(reservation) {
  reservationEditing = {
    id: reservation.id,
    revision: reservations.revision,
    status: reservation.status,
  };
  latestReservation = null;
  renderReservationDetails(reservation);
  setStatusOptions(reservation);
  reservationForm.elements.pickupTime.value = reservation.pickup?.time || "";
  reservationForm.elements.pickupPlace.value = reservation.pickup?.place || "";
  reservationForm.elements.staffNote.value = reservation.staffNote || "";
  const terminal = ["collected", "cancelled"].includes(reservation.status);
  $("#reservation-fields").disabled = terminal;
  $("#reservation-save").hidden = terminal;
  $("#reservation-save").disabled = false;
  $("#reservation-conflict").hidden = $("#reservation-discard").hidden = true;
  $("#reservation-edit-message").textContent = terminal
    ? "This reservation is closed."
    : "";
  if (!reservationDialog.open) reservationDialog.showModal();
}
$("#reservation-status").onchange = updatePickupRequirements;
$("#close-reservation").onclick = () => {
  if (!reservationSaving) reservationDialog.close();
};
reservationDialog.oncancel = (event) => {
  if (reservationSaving) event.preventDefault();
};
reservationDialog.onclose = () => {
  reservationEditing = latestReservation = null;
  reservationForm.reset();
};
reservationForm.onsubmit = async (event) => {
  event.preventDefault();
  if (!reservationEditing || reservationSaving) return;
  if (
    $("#reservation-status").value === "cancelled" &&
    !window.confirm(
      "Cancel this pickup reservation? The customer will see this status.",
    )
  )
    return;
  if (
    $("#reservation-status").value === "collected" &&
    !window.confirm(
      "Mark this reservation collected after the handover is confirmed on site?",
    )
  )
    return;
  reservationSaving = true;
  $("#reservation-save").disabled = $("#close-reservation").disabled = true;
  $("#reservation-fields").disabled = true;
  $("#reservation-edit-message").textContent = "Saving reservation…";
  const id = reservationEditing.id;
  try {
    reservations = await api("reservations", "PATCH", {
      revision: reservationEditing.revision,
      id,
      status: reservationForm.elements.status.value,
      pickup: {
        time: reservationForm.elements.pickupTime.value.trim(),
        place: reservationForm.elements.pickupPlace.value.trim(),
      },
      staffNote: reservationForm.elements.staffNote.value.trim(),
    });
    const saved = reservations.reservations.find(
      (reservation) => reservation.id === id,
    );
    renderReservations();
    $("#reservation-updated").textContent =
      "Updated " + dateTime.format(new Date()) + " · Shanghai";
    reservationDialog.close();
    $("#dashboard-message").textContent =
      "Saved " +
      (saved?.reference || "reservation") +
      ". " +
      (saved?.status === "confirmed" || saved?.status === "ready"
        ? "Contact the customer with the pickup details."
        : "");
  } catch (error) {
    if (expired(error)) return;
    $("#reservation-edit-message").textContent = error.message;
    if (error.status === 409) {
      $("#reservation-conflict").hidden = false;
      $("#reservation-latest").textContent = "Loading latest saved details…";
      $("#reservation-review-latest").disabled = true;
      try {
        reservations = await api("reservations");
        renderReservations();
        latestReservation = reservations.reservations.find(
          (reservation) => reservation.id === id,
        );
        $("#reservation-latest").textContent = latestReservation
          ? [
              "Saved status: " + statusLabels[latestReservation.status],
              "Pickup: " +
                (latestReservation.pickup?.time || "—") +
                " · " +
                (latestReservation.pickup?.place || "—"),
              "Customer message: " + (latestReservation.staffNote || "—"),
            ].join("\n")
          : "This reservation is no longer available.";
        $("#reservation-review-latest").textContent =
          "Keep draft on latest version";
        $("#reservation-review-latest").disabled =
          !latestReservation ||
          ["collected", "cancelled"].includes(latestReservation.status);
        $("#reservation-discard").hidden = !latestReservation;
      } catch (refreshError) {
        if (!expired(refreshError))
          $("#reservation-latest").textContent =
            "Latest details could not be loaded. Close this window and refresh before trying again. Your draft is still shown above.";
      }
    } else $("#reservation-save").disabled = false;
  } finally {
    reservationSaving = false;
    $("#close-reservation").disabled = false;
    $("#reservation-fields").disabled = false;
  }
};
$("#reservation-review-latest").onclick = () => {
  if (!latestReservation || !reservationEditing) return;
  const priorStatus = $("#reservation-status").value;
  reservationEditing = {
    id: latestReservation.id,
    revision: reservations.revision,
    status: latestReservation.status,
  };
  renderReservationDetails(latestReservation);
  setStatusOptions(latestReservation, priorStatus);
  $("#reservation-conflict").hidden = true;
  $("#reservation-save").disabled = false;
  $("#reservation-edit-message").textContent =
    "Your draft has been kept. Review the fields and save again." +
    (priorStatus !== $("#reservation-status").value
      ? " Status was reset because that change is no longer available."
      : "");
};
$("#reservation-discard").onclick = () => {
  if (
    latestReservation &&
    window.confirm(
      "Discard the unsaved fields and load the latest saved reservation?",
    )
  )
    openReservation(latestReservation);
};

function openEditor(product) {
  editing = { id: product.id, revision: catalog.revision };
  $("#edit-id").textContent = product.id;
  for (const key of ["name", "name_en", "price"])
    editForm.elements.namedItem(key).value = product[key];
  editForm.elements.listed.checked = product.listed;
  $("#reload").hidden = true;
  $("#save").disabled = false;
  $("#edit-message").textContent = "";
  if (!dialog.open) dialog.showModal();
}
$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  submit.disabled = true;
  $("#access-message").textContent = "Signing in…";
  try {
    await api("session", "POST", { password: form.elements.password.value });
    form.reset();
    await load();
  } catch (error) {
    if (!error.stale) $("#access-message").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
$("#sign-out").onclick = async () => {
  $("#sign-out").disabled = true;
  try {
    await api("session", "DELETE");
    showAccess("Signed out.", true);
    $("#login input").focus();
  } catch (error) {
    if (!expired(error)) $("#dashboard-message").textContent = error.message;
  } finally {
    $("#sign-out").disabled = false;
  }
};
$("#retry-access").onclick = $("#refresh-dashboard").onclick = load;
$("#close-editor").onclick = () => {
  if (!saving) dialog.close();
};
dialog.oncancel = (event) => {
  if (saving) event.preventDefault();
};
editForm.onsubmit = async (event) => {
  event.preventDefault();
  if (!editing || saving) return;
  saving = true;
  $("#save").disabled = true;
  $("#edit-message").textContent = "Saving…";
  try {
    const fields = editForm.elements;
    catalog = await api("catalog", "PATCH", {
      ...editing,
      name_en: fields.name_en.value.trim(),
      name: fields.namedItem("name").value.trim(),
      price: fields.price.valueAsNumber,
      listed: fields.listed.checked,
    });
    dialog.close();
    render();
    $("#feedback").textContent = "Saved " + editing.id + ".";
  } catch (error) {
    if (expired(error)) return;
    $("#edit-message").textContent = error.message;
    if (error.status === 409) $("#reload").hidden = false;
    else $("#save").disabled = false;
  } finally {
    saving = false;
  }
};
$("#reload").onclick = async () => {
  const id = editing?.id;
  if (
    !id ||
    !window.confirm(
      "Discard the unsaved product changes and load the latest version?",
    )
  )
    return;
  await load();
  const product = catalog?.products.find((item) => item.id === id);
  if (product) openEditor(product);
};
function csvValue(value) {
  const text = String(value);
  return (
    '"' +
    (/^\s*[=+\-@]/.test(text) ? "'" : "") +
    text.replaceAll('"', '""') +
    '"'
  );
}
$("#export-csv").onclick = () => {
  if (!catalog) return;
  const rows = [
    ["ID", "Name (EN)", "Name (ZH)", "Price (CNY)", "Category", "Listed"],
  ];
  for (const product of catalog.products.filter(matches))
    rows.push([
      product.id,
      product.name_en,
      product.name,
      product.price,
      details.get(product.id)?.category || "",
      product.listed,
    ]);
  const url = URL.createObjectURL(
    new Blob(
      ["\ufeff", rows.map((row) => row.map(csvValue).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "wlsa-catalog.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
for (const [id, name] of categoryNames)
  $("#category-filter").add(new Option(name, id));
for (const control of document.querySelectorAll(
  ".catalog-tools input, .catalog-tools select",
))
  control.addEventListener("input", render);
for (const control of document.querySelectorAll(
  ".reservation-tools input, .reservation-tools select",
))
  control.addEventListener("input", renderReservations);
load();
