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
const editForm = $("#edit-form");
const dialog = $("#editor");
let catalog;
let editing;
let saving = false;

async function api(endpoint, method = "GET", data) {
  const response = await fetch("/api/admin/" + endpoint, {
    method,
    cache: "no-store",
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 204) return;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.error || "Store service unavailable. Please try again.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

function showAccess(message, login) {
  dialog.close();
  catalog = null;
  $("#catalog-rows").replaceChildren();
  $("#workspace").hidden = $("#sign-out").hidden = true;
  $("#access").hidden = false;
  $("#access-message").textContent = message;
  $("#login").hidden = !login;
  $("#retry-access").hidden = login;
}

async function load() {
  try {
    catalog = await api("catalog");
    $("#access").hidden = true;
    $("#workspace").hidden = $("#sign-out").hidden = false;
    render();
  } catch (error) {
    showAccess(error.status === 401 ? "" : error.message, error.status === 401);
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
  const products = catalog.products.filter(matches);
  const body = $("#catalog-rows");
  body.replaceChildren();
  $("#result-count").textContent =
    products.length + " of " + catalog.products.length + " products";
  for (const product of products) {
    const detail = details.get(product.id);
    const row = body.insertRow();
    const name = row.insertCell();
    const title = document.createElement("strong");
    title.textContent = product.name_en;
    const secondary = document.createElement("small");
    secondary.textContent = product.name + " · " + product.id;
    name.append(title, secondary);
    row.insertCell().textContent = categoryNames.get(detail?.category) || "—";
    row.insertCell().textContent = currency.format(product.price);
    const status = row.insertCell();
    status.textContent = product.listed ? "Listed" : "Hidden";
    status.className = product.listed ? "listed" : "muted";
    const edit = document.createElement("button");
    edit.className = "button";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit " + product.name_en);
    edit.onclick = () => openEditor(product);
    row.insertCell().append(edit);
  }
}

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
    $("#access-message").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
$("#sign-out").onclick = async () => {
  try {
    await api("session", "DELETE");
    showAccess("Signed out.", true);
    $("#login input").focus();
  } catch (error) {
    $("#feedback").textContent = error.message;
  }
};
$("#retry-access").onclick = load;
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
    $("#edit-message").textContent = error.message;
    if (error.status === 401)
      showAccess("Session expired. Sign in to edit again.", true);
    else if (error.status === 409) $("#reload").hidden = false;
    else $("#save").disabled = false;
  } finally {
    saving = false;
  }
};
$("#reload").onclick = async () => {
  await load();
  if (catalog)
    openEditor(catalog.products.find((product) => product.id === editing.id));
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
  const rows = [
    ["ID", "Name (EN)", "Name (ZH)", "Price (CNY)", "Category", "Listed"],
  ];
  for (const product of catalog.products.filter(matches)) {
    rows.push([
      product.id,
      product.name_en,
      product.name,
      product.price,
      details.get(product.id)?.category || "",
      product.listed,
    ]);
  }
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
load();
