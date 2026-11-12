"use strict";

/* --------------------------------------------------------------- elements */

const el = (id) => document.getElementById(id);

const els = {
  form: el("credentials-form"),
  apiKey: el("apiKey"),
  objectKey: el("objectKey"),
  objectHint: el("object-hint"),
  fetchButton: el("fetch-button"),
  cancelButton: el("cancel-fetch"),
  status: el("status"),
  loader: el("loader"),
  schemaBadge: el("schema-badge"),
  filterBar: el("filter-bar"),
  filterField: el("filter-field-select"),
  filterValue: el("filter-value-select"),
  filterRange: el("filter-range"),
  filterFrom: el("filter-date-from"),
  filterTo: el("filter-date-to"),
  resetFilter: el("reset-filter"),
  downloadCsv: el("download-csv"),
  downloadImages: el("download-images"),
  importList: el("import-contact-list"),
  pagination: el("pagination"),
  prevPage: el("prev-page"),
  nextPage: el("next-page"),
  pageInfo: el("page-info"),
  pageSize: el("page-size"),
  results: el("results"),
  tableHead: el("table-head"),
  tableBody: el("table-body"),
  urlFeature: el("url-feature"),
  urlColumn: el("url-column-select"),
  imageCountNote: el("image-count-note"),
  imageProgress: el("image-download-progress"),
  progressFill: el("progress-fill"),
  progressText: el("progress-text"),
};

/* ------------------------------------------------------------------ state */

const PAGE_LIMIT = 1000; // API maximum, confirmed: limit=2000 returns 400
const MAX_PAGES = 50; // 50 pages x 1000 = 50k records
const CONTACT_CONCURRENCY = 6;
const CONTACT_CAP = 2000;

const state = {
  apiKey: "",
  objectKey: "",
  schema: null,
  columns: [],
  records: [],
  filtered: [],
  page: 1,
  pageSize: Number(els.pageSize?.value || 100),
  filter: { field: "", value: "__ALL__", from: "", to: "" },
  contacts: new Map(),
  aborter: null,
  loading: false,
  truncated: false,
  partial: false,
  seen: new Set(),
  urlColumns: [],
  urlColumn: "",
};

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const utcOffsetLabel = computeUtcOffsetLabel(timezone);

/* ------------------------------------------------------------------ setup */

restoreLastObjectKey();

els.form.addEventListener("submit", onSubmit);
els.cancelButton.addEventListener("click", cancelFetch);
els.objectKey.addEventListener("input", debounce(updateObjectHint, 500));

els.filterField.addEventListener("change", onFilterFieldChange);
els.filterValue.addEventListener("change", () => {
  state.filter.value = els.filterValue.value;
  applyFilter();
});
els.filterFrom.addEventListener("change", onDateRangeChange);
els.filterTo.addEventListener("change", onDateRangeChange);
els.resetFilter.addEventListener("click", resetFilter);
els.downloadCsv.addEventListener("click", () => {
  if (state.filtered.length) downloadCsv(state.filtered);
});
els.downloadImages.addEventListener("click", () => {
  downloadImages(state.filtered).catch((err) => setStatus(err.message, "error"));
});
els.importList.addEventListener("click", importAsContactList);
els.prevPage.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    render();
  }
});
els.nextPage.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  if (state.page < totalPages) {
    state.page += 1;
    render();
  }
});
els.pageSize.addEventListener("change", () => {
  const size = Number(els.pageSize.value);
  if (size > 0) {
    state.pageSize = size;
    state.page = 1;
    render();
  }
});
els.urlColumn.addEventListener("change", () => {
  state.urlColumn = els.urlColumn.value;
  updateImageControls();
});

window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  setStatus(event.reason?.message || "Unexpected error.", "error");
});

/* ------------------------------------------------------------- submission */

async function onSubmit(event) {
  event.preventDefault();
  if (state.loading) return;

  // Stop a previous run's paging or contact enrichment before starting over.
  state.aborter?.abort();

  const apiKey = els.apiKey.value.trim();
  const objectKey = els.objectKey.value.trim();

  if (!apiKey || !objectKey) {
    setStatus("Both fields are required.", "error");
    return;
  }

  resetResults();
  startLoading();

  const aborter = new AbortController();
  state.aborter = aborter;
  state.apiKey = apiKey;
  state.objectKey = objectKey;

  try {
    setStatus("Looking up object schema…", "pending");
    state.schema = await fetchSchema(apiKey, objectKey, aborter.signal);
    renderSchemaBadge(state.schema);
    els.objectHint.textContent = describeSchema(state.schema);
    els.objectHint.className = "field-hint ok";

    // Paint page 1 immediately, then keep pulling pages in the background so a
    // 10k-record object shows its first rows in ~0.6s instead of ~6s.
    setStatus("Fetching first page…", "pending");
    const firstPage = await fetchPage(apiKey, objectKey, "", aborter.signal);

    if (!firstPage.records.length) {
      setStatus("No records found for this object.", "error");
      return;
    }

    state.records = [];
    state.seen = new Set();
    appendRecords(firstPage.records);
    state.filtered = state.records;
    state.columns = buildColumns(state.records);
    state.page = 1;

    detectUrlColumns();
    render();
    showLoadingChrome();
    setStatus(
      `Loaded ${plural(state.records.length, "record")}… still fetching.`,
      "pending",
    );

    let continuationToken = firstPage.nextContinuationToken;
    let pages = 1;

    while (continuationToken && pages < MAX_PAGES) {
      if (aborter.signal.aborted) throw abortError();
      pages += 1;
      const page = await fetchPage(
        apiKey,
        objectKey,
        continuationToken,
        aborter.signal,
      );
      if (aborter.signal.aborted) throw abortError();
      continuationToken = page.nextContinuationToken;
      appendRecords(page.records);
      render();
      setStatus(
        `Loaded ${plural(state.records.length, "record")}… still fetching.`,
        "pending",
      );
    }

    // A token here means we stopped at the page cap, not at the end.
    state.truncated = Boolean(continuationToken);
    completeLoad({ partial: false });
  } catch (err) {
    if (err.name === "AbortError") {
      if (state.records.length) {
        completeLoad({ partial: true });
        setStatus(
          `Cancelled — showing the ${plural(state.records.length, "record")} loaded so far.`,
          "error",
        );
      } else {
        setStatus("Cancelled.", "error");
      }
    } else {
      console.error(err);
      if (state.records.length) {
        completeLoad({ partial: true });
        setStatus(
          `${err.message || "Fetch failed."} Showing the ${plural(state.records.length, "record")} loaded so far.`,
          "error",
        );
      } else {
        setStatus(err.message || "Failed to fetch records.", "error");
      }
    }
  } finally {
    stopLoading();
  }
}

// Chrome visible while pages are still arriving: table + pagination only.
// Filters and exports stay hidden so their counts can never be partial.
function showLoadingChrome() {
  els.results.style.display = "block";
  els.pagination.style.display = "flex";
  els.filterBar.style.display = "none";
  els.downloadCsv.style.display = "none";
  els.importList.style.display = "none";
  els.downloadImages.style.display = "none";
}

function completeLoad({ partial }) {
  state.partial = partial;
  state.columns = buildColumns(state.records);
  state.filtered = state.records;

  buildFilterFields();

  els.results.style.display = "block";
  els.pagination.style.display = "flex";
  els.filterBar.style.display = "flex";
  els.downloadCsv.style.display = "inline-flex";
  els.importList.style.display = "inline-flex";
  els.downloadImages.style.display = state.urlColumns.length
    ? "inline-flex"
    : "none";

  if (partial) {
    els.schemaBadge.textContent = `${els.schemaBadge.textContent.replace(/ · partial$/, "")} · partial`;
  }

  const suffix = state.truncated
    ? ` Stopped at ${MAX_PAGES * PAGE_LIMIT} records (page cap).`
    : "";
  const note = partial ? " Partial data — run again for the full set." : "";
  setStatus(
    `Loaded ${plural(state.records.length, "record")} from ${state.schema.displayName || state.objectKey}.${suffix}${note}`,
    state.truncated || partial ? "error" : "ok",
  );

  localStorage.setItem("coe:lastObjectKey", state.objectKey);

  if (!partial) {
    enrichContactsInBackground(state.apiKey, state.records, state.aborter?.signal);
  }
}

function cancelFetch() {
  state.aborter?.abort();
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function startLoading() {
  state.loading = true;
  els.loader.classList.add("show");
  els.fetchButton.disabled = true;
  els.cancelButton.hidden = false;
  els.results.style.display = "none";
  els.filterBar.style.display = "none";
  els.pagination.style.display = "none";
}

function stopLoading() {
  state.loading = false;
  els.loader.classList.remove("show");
  els.fetchButton.disabled = false;
  els.cancelButton.hidden = true;
}

function resetResults() {
  state.schema = null;
  state.columns = [];
  state.records = [];
  state.filtered = [];
  state.page = 1;
  state.truncated = false;
  state.partial = false;
  state.seen = new Set();
  state.urlColumns = [];
  state.urlColumn = "";
  state.filter = { field: "", value: "__ALL__", from: "", to: "" };
  els.schemaBadge.hidden = true;
  els.objectHint.textContent = "";
  els.objectHint.className = "field-hint";
  updateActionVisibility(false);
}

function updateActionVisibility(visible) {
  const display = visible ? "inline-flex" : "none";
  els.downloadCsv.style.display = display;
  els.downloadImages.style.display =
    visible && state.urlColumns.length ? display : "none";
  els.importList.style.display = display;
  els.filterBar.style.display = visible ? "flex" : "none";
  els.pagination.style.display = visible ? "flex" : "none";
  if (!visible) {
    els.results.style.display = "none";
    els.schemaBadge.hidden = true;
  }
}

/* ------------------------------------------------------------------- API */

async function apiPost(path, payload, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail =
      (typeof data === "string" ? data : data && (data.error || data.message)) ||
      text;
    const err = new Error(
      typeof detail === "string" && detail.trim()
        ? `Request failed (${res.status}): ${detail.trim()}`
        : `Request failed (${res.status})`,
    );
    err.status = res.status;
    throw err;
  }

  return data || {};
}

async function fetchSchema(apiKey, objectKey, signal) {
  try {
    const schema = await apiPost("/api/schema", { apiKey, objectKey }, signal);
    if (!schema || !schema.objectKey) {
      throw new Error("Object not found.");
    }
    return schema;
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      throw new Error(`Object "${objectKey}" was not found. Check the object key.`);
    }
    throw err;
  }
}

async function fetchPage(apiKey, objectKey, continuationToken, signal) {
  const data = await apiPost(
    "/api/records",
    { apiKey, objectKey, continuationToken: continuationToken || "" },
    signal,
  );

  return {
    records: Array.isArray(data.records) ? data.records : [],
    nextContinuationToken: data.nextContinuationToken || "",
  };
}

// Pages can overlap; key on the fields that identify a record.
function appendRecords(records) {
  for (const record of records) {
    const key = `${record.primaryPropertyValue}|${record.createdAt}`;
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    state.records.push(record);
  }
  state.filtered = state.records;
}

/* --------------------------------------------------------------- columns */

function buildColumns(records) {
  const columns = [];
  const seen = new Set();

  const add = (column) => {
    if (!column.key || seen.has(column.key)) return;
    seen.add(column.key);
    columns.push(column);
  };

  add({ key: "primaryPropertyValue", label: "Primary value", type: "text" });

  const properties = [...(state.schema?.properties || [])].sort(
    (a, b) => (a.displayOrder ?? 999) - (b.displayOrder ?? 999),
  );

  for (const property of properties) {
    const label = property.displayName || property.uniqueIdentifier;
    add({
      key: property.uniqueIdentifier,
      label,
      type: property.propertyType || "text",
      options: (property.options || []).map((option) => option.value),
    });

    if (property.propertyType === "datetime") {
      add({
        key: `${property.uniqueIdentifier}_local`,
        label: `${label} (${utcOffsetLabel})`,
        type: "datetime",
        base: property.uniqueIdentifier,
        local: true,
      });
    }
  }

  // Anything present in the records but missing from the schema still shows up.
  const datetimeKeys = detectDatetimeKeys(records);
  const extras = new Set();
  for (const record of records) {
    for (const key of Object.keys(record.propertyValues || {})) {
      if (!seen.has(key)) extras.add(key);
    }
  }
  for (const key of [...extras].sort()) {
    add({ key, label: key, type: datetimeKeys.has(key) ? "datetime" : "text" });
    if (datetimeKeys.has(key)) {
      add({
        key: `${key}_local`,
        label: `${key} (${utcOffsetLabel})`,
        type: "datetime",
        base: key,
        local: true,
      });
    }
  }

  add({ key: "contactName", label: "Contact name", type: "text" });
  add({ key: "referencedUserProfileId", label: "Referenced profile ID", type: "text" });
  add({ key: "createdAt", label: "Created at", type: "datetime", raw: true });
  add({
    key: "createdAt_local",
    label: `Created at (${utcOffsetLabel})`,
    type: "datetime",
    base: "createdAt",
    local: true,
    raw: true,
  });
  add({ key: "updatedAt", label: "Updated at", type: "datetime", raw: true });
  add({
    key: "updatedAt_local",
    label: `Updated at (${utcOffsetLabel})`,
    type: "datetime",
    base: "updatedAt",
    local: true,
    raw: true,
  });

  return columns;
}

function detectDatetimeKeys(records) {
  const counts = new Map();
  const sample = records.slice(0, 200);

  for (const record of sample) {
    for (const [key, value] of Object.entries(record.propertyValues || {})) {
      if (typeof value !== "string" || !looksLikeDateTime(value)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const keys = new Set();
  for (const [key, count] of counts) {
    if (count >= Math.max(1, Math.floor(sample.length * 0.5))) keys.add(key);
  }
  return keys;
}

function looksLikeDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function cellValue(record, column) {
  if (column.local) {
    const raw = column.raw ? record[column.base] : record.propertyValues?.[column.base];
    return formatLocal(raw);
  }

  switch (column.key) {
    case "primaryPropertyValue":
      return record.primaryPropertyValue ?? "";
    case "contactName":
      return record.contactName ?? "";
    case "referencedUserProfileId":
      return record.referencedUserProfileId ?? "";
    case "createdAt":
      return record.createdAt ?? "";
    case "updatedAt":
      return record.updatedAt ?? "";
    default: {
      const value = record.propertyValues?.[column.key];
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) return value.join(", ");
      if (typeof value === "object") return JSON.stringify(value);
      return value;
    }
  }
}

function formatLocal(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("sv-SE", { timeZone: timezone });
}

/* --------------------------------------------------------------- render */

function render() {
  renderTable();
  renderPagination();
  updateImageControls();
  updateImportState();
}

function renderTable() {
  els.tableHead.innerHTML = "";
  const headRow = document.createElement("tr");
  for (const column of state.columns) {
    const th = document.createElement("th");
    th.textContent = column.label;
    th.title = column.key;
    headRow.appendChild(th);
  }
  els.tableHead.appendChild(headRow);

  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;

  const start = (state.page - 1) * state.pageSize;
  const rows = state.filtered.slice(start, start + state.pageSize);

  els.tableBody.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const record of rows) {
    const tr = document.createElement("tr");
    for (const column of state.columns) {
      const td = document.createElement("td");
      const value = cellValue(record, column);
      td.textContent = value;
      if (column.type === "single_choice" || column.type === "multiple_choice") {
        td.title = value;
      }
      tr.appendChild(td);
    }
    fragment.appendChild(tr);
  }
  els.tableBody.appendChild(fragment);
  els.results.style.display = "block";
}

function renderPagination() {
  const total = state.filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const start = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const end = Math.min(total, state.page * state.pageSize);

  els.pageInfo.textContent = `Showing ${start}-${end} of ${total} • Page ${state.page}/${totalPages}`;
  els.prevPage.disabled = state.page <= 1;
  els.nextPage.disabled = state.page >= totalPages;
}

function renderSchemaBadge(schema) {
  const fields = (schema.properties || []).length;
  els.schemaBadge.textContent = `${schema.displayName || schema.objectKey} · ${schema.objectKey} · ${plural(fields, "field")} · ${schema.relationshipType || "custom object"}`;
  els.schemaBadge.hidden = false;
}

function describeSchema(schema) {
  const fields = (schema.properties || []).length;
  return `${schema.displayName || schema.objectKey} · ${plural(fields, "field")}`;
}

/* --------------------------------------------------------------- filters */

function buildFilterFields() {
  els.filterField.innerHTML = "";
  for (const column of state.columns) {
    const option = document.createElement("option");
    option.value = column.key;
    option.textContent = column.label;
    els.filterField.appendChild(option);
  }

  const first = state.columns[0]?.key || "";
  els.filterField.value = first;
  state.filter.field = first;
  onFilterFieldChange();
}

function currentColumn() {
  return state.columns.find((column) => column.key === state.filter.field) || null;
}

function onFilterFieldChange() {
  state.filter.field = els.filterField.value;
  state.page = 1;

  const column = currentColumn();
  if (!column) return;

  if (isDateColumn(column)) {
    els.filterValue.style.display = "none";
    els.filterRange.style.display = "flex";
    els.filterFrom.value = "";
    els.filterTo.value = "";
    state.filter.from = "";
    state.filter.to = "";
  } else {
    els.filterValue.style.display = "block";
    els.filterRange.style.display = "none";
    populateFilterValues(column);
  }

  applyFilter();
}

function populateFilterValues(column) {
  const values = new Set();

  if (Array.isArray(column.options) && column.options.length) {
    for (const option of column.options) values.add(String(option));
  } else {
    for (const record of state.records) {
      const value = cellValue(record, column);
      if (value === "" || value === null || value === undefined) continue;
      values.add(String(value));
      if (values.size > 1000) break;
    }
  }

  const sorted = [...values].sort((a, b) => a.localeCompare(b));
  els.filterValue.innerHTML = "";

  const all = document.createElement("option");
  all.value = "__ALL__";
  all.textContent = "All";
  els.filterValue.appendChild(all);

  for (const value of sorted) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    els.filterValue.appendChild(option);
  }

  els.filterValue.value = "__ALL__";
  state.filter.value = "__ALL__";
}

function onDateRangeChange() {
  state.filter.from = els.filterFrom.value;
  state.filter.to = els.filterTo.value;
  state.page = 1;
  applyFilter();
}

function applyFilter() {
  const column = currentColumn();
  if (!column) {
    state.filtered = state.records;
    render();
    return;
  }

  if (isDateColumn(column)) {
    const from = parseUtcInput(state.filter.from);
    const to = parseUtcInput(state.filter.to);

    state.filtered = state.records.filter((record) => {
      const raw = column.local
        ? column.raw
          ? record[column.base]
          : record.propertyValues?.[column.base]
        : cellValue(record, column);
      const timestamp = Date.parse(raw);
      if (Number.isNaN(timestamp)) return false;
      if (from !== null && timestamp < from) return false;
      if (to !== null && timestamp > to) return false;
      return true;
    });
  } else if (state.filter.value === "__ALL__") {
    state.filtered = state.records;
  } else {
    const wanted = String(state.filter.value);
    state.filtered = state.records.filter(
      (record) => String(cellValue(record, column)) === wanted,
    );
  }

  state.page = 1;
  render();
  setStatus(
    `Showing ${state.filtered.length} of ${state.records.length} records.`,
    "ok",
  );
}

function resetFilter() {
  if (!state.records.length) return;
  state.filter = { field: state.columns[0]?.key || "", value: "__ALL__", from: "", to: "" };
  els.filterField.value = state.filter.field;
  els.filterFrom.value = "";
  els.filterTo.value = "";
  els.filtered = state.records;
  state.page = 1;
  onFilterFieldChange();
  setStatus(`Showing ${state.records.length} records.`, "ok");
}

function isDateColumn(column) {
  return column.type === "datetime" || column.key === "createdAt" || column.key === "updatedAt";
}

// datetime-local inputs carry no zone; the UI says UTC, so treat them as UTC.
function parseUtcInput(value) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
    ? `${value}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/* ------------------------------------------------------------ CSV export */

function downloadCsv(records) {
  const columns = state.columns;
  const headerLabels = uniqueLabels(columns);

  const lines = [headerLabels.map(escapeCsv).join(",")];

  for (const record of records) {
    const row = columns.map((column) => escapeCsv(cellValue(record, column)));
    lines.push(row.join(","));
  }

  // BOM keeps Excel from mangling non-ASCII names.
  const csv = `\uFEFF${lines.join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.objectKey || "records"}-${timestampSlug()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function uniqueLabels(columns) {
  const seen = new Map();
  return columns.map((column) => {
    const count = (seen.get(column.label) || 0) + 1;
    seen.set(column.label, count);
    return count === 1 ? column.label : `${column.label} [${column.key}]`;
  });
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Neutralise spreadsheet formula execution.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/* ---------------------------------------------------------- file download */

function detectUrlColumns() {
  const candidates = state.columns.filter(
    (column) => !column.local && column.type !== "datetime" && column.type !== "single_choice",
  );
  const sample = state.records.slice(0, 200);
  const urlPattern = /^https?:\/\//i;
  const found = [];

  for (const column of candidates) {
    let nonEmpty = 0;
    let urls = 0;

    for (const record of sample) {
      const value = String(cellValue(record, column) ?? "").trim();
      if (!value) continue;
      nonEmpty += 1;
      if (urlPattern.test(value)) urls += 1;
    }

    if (nonEmpty > 0 && urls / nonEmpty > 0.5) found.push(column);
  }

  state.urlColumns = found;
  state.urlColumn = found[0]?.key || "";

  if (!found.length) {
    els.urlFeature.style.display = "none";
    return;
  }

  els.urlColumn.innerHTML = "";
  for (const column of found) {
    const option = document.createElement("option");
    option.value = column.key;
    option.textContent = column.label;
    els.urlColumn.appendChild(option);
  }
  els.urlColumn.value = state.urlColumn;
  els.urlFeature.style.display = "flex";
}

function urlColumn() {
  return state.columns.find((column) => column.key === state.urlColumn) || null;
}

function recordsWithFiles(records) {
  const column = urlColumn();
  if (!column) return [];
  return records.filter((record) =>
    /^https?:\/\//i.test(String(cellValue(record, column) || "").trim()),
  );
}

function updateImageControls() {
  if (!state.urlColumns.length) {
    els.imageCountNote.textContent = "";
    return;
  }
  const withFiles = recordsWithFiles(state.filtered);
  els.imageCountNote.textContent = `${withFiles.length} of ${state.filtered.length} records have files.`;
  els.downloadImages.disabled = withFiles.length === 0;
}

async function downloadImages(records) {
  const column = urlColumn();
  if (!column) return;

  if (!window.JSZip) {
    setStatus("JSZip did not load. File download is unavailable.", "error");
    return;
  }

  const withFiles = recordsWithFiles(records);
  if (!withFiles.length) {
    setStatus("No file URLs available for download.", "error");
    return;
  }

  const total = withFiles.length;
  const zip = new JSZip();
  let completed = 0;
  let failed = 0;

  showProgress(true);
  setProgress(0, total, "Downloading");

  const queue = [...withFiles];
  const worker = async () => {
    while (queue.length) {
      const record = queue.shift();
      const url = String(cellValue(record, column) || "").trim();
      const index = withFiles.indexOf(record) + 1;
      try {
        const blob = await fetchFile(url);
        zip.file(fileName(url, index), blob);
      } catch (err) {
        console.error("File fetch failed", url, err);
        failed += 1;
      } finally {
        completed += 1;
        setProgress(completed, total, "Downloading");
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, total) }, () => worker()),
  );

  setProgress(total, total, "Compressing");
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.objectKey || "files"}-${timestampSlug()}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showProgress(false);
  setStatus(
    `Downloaded ${plural(total - failed, "file")}${failed ? `, ${failed} failed` : ""}.`,
    failed ? "error" : "ok",
  );
}

async function fetchFile(url) {
  const res = await fetch(`/proxy-image?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`File fetch failed (${res.status}) ${detail}`.trim());
  }
  return res.blob();
}

function fileName(url, index) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const base = parts.length ? parts[parts.length - 1] : "file";
    const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
    return `${String(index).padStart(3, "0")}_${safe}`;
  } catch {
    return `${String(index).padStart(3, "0")}_file`;
  }
}

function showProgress(visible) {
  els.imageProgress.hidden = !visible;
  if (!visible) {
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "";
  }
}

function setProgress(done, total, label) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = `${percent}%`;
  els.progressText.textContent = `${label} ${done} of ${total}…`;
}

/* ------------------------------------------------------- contact enrichment */

async function enrichContactsInBackground(apiKey, records, signal) {
  const ids = [
    ...new Set(records.map((record) => record.referencedUserProfileId).filter(Boolean)),
  ].filter((id) => !state.contacts.has(id));

  if (!ids.length) {
    applyContactNames(records);
    return;
  }

  const capped = ids.slice(0, CONTACT_CAP);
  let done = 0;
  let lastRender = 0;

  const queue = [...capped];
  const worker = async () => {
    while (queue.length) {
      if (signal.aborted) return;
      const id = queue.shift();
      try {
        const contact = await apiPost("/api/contact", { apiKey, userProfileId: id }, signal);
        state.contacts.set(id, contactName(contact));
      } catch {
        state.contacts.set(id, "");
      }
      done += 1;

      if (done - lastRender >= 25) {
        lastRender = done;
        applyContactNames(records);
        render();
        setStatus(`Loading contact names… ${done}/${capped.length}`, "pending");
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONTACT_CONCURRENCY, capped.length) }, () => worker()),
  );

  if (signal.aborted) return;

  applyContactNames(records);
  render();

  const note = ids.length > CONTACT_CAP ? ` (capped at ${CONTACT_CAP})` : "";
  setStatus(
    `Loaded ${plural(records.length, "record")}; resolved ${capped.length} contact${capped.length === 1 ? "" : "s"}${note}.`,
    "ok",
  );
}

function contactName(contact) {
  if (!contact) return "";
  const name = [contact.FirstName, contact.LastName].filter(Boolean).join(" ").trim();
  return name || contact.PhoneNumber || contact.Email || "";
}

function applyContactNames(records) {
  for (const record of records) {
    const name = state.contacts.get(record.referencedUserProfileId);
    if (name) record.contactName = name;
  }
}

/* --------------------------------------------------------- contact list */

async function importAsContactList() {
  const ids = [
    ...new Set(
      state.filtered.map((record) => record.referencedUserProfileId).filter(Boolean),
    ),
  ];

  if (!ids.length) {
    setStatus("No referenced profile IDs in the filtered records.", "error");
    return;
  }

  const name = prompt(`Create a contact list from ${ids.length} profiles?\n\nList name:`);
  if (!name || !name.trim()) {
    setStatus("Contact list name is required.", "error");
    return;
  }

  els.importList.disabled = true;
  setStatus(`Creating "${name.trim()}"…`, "pending");

  try {
    await apiPost("/api/contact/list", {
      apiKey: state.apiKey,
      groupListName: name.trim(),
      userProfileIds: ids,
    });
    setStatus(`Created "${name.trim()}" with ${plural(ids.length, "profile")}.`, "ok");
  } catch (err) {
    setStatus(err.message || "Failed to create contact list.", "error");
  } finally {
    els.importList.disabled = false;
  }
}

function updateImportState() {
  const count = new Set(
    state.filtered.map((record) => record.referencedUserProfileId).filter(Boolean),
  ).size;
  els.importList.disabled = count === 0;
  els.importList.title = count ? "" : "No referenced profile IDs in these records.";
}

/* ------------------------------------------------------------- object hint */

let hintAbort = null;

async function updateObjectHint() {
  const apiKey = els.apiKey.value.trim();
  const objectKey = els.objectKey.value.trim();

  hintAbort?.abort();
  hintAbort = null;

  if (!apiKey || !objectKey) {
    els.objectHint.textContent = "";
    els.objectHint.className = "field-hint";
    return;
  }

  const controller = new AbortController();
  hintAbort = controller;

  try {
    const schema = await fetchSchema(apiKey, objectKey, controller.signal);
    els.objectHint.textContent = `✓ ${describeSchema(schema)}`;
    els.objectHint.className = "field-hint ok";
  } catch (err) {
    if (err.name === "AbortError") return;
    els.objectHint.textContent = `✗ ${err.message.replace(/^Request failed \(\d+\): /, "")}`;
    els.objectHint.className = "field-hint error";
  }
}

/* ---------------------------------------------------------------- misc */

function restoreLastObjectKey() {
  try {
    const last = localStorage.getItem("coe:lastObjectKey");
    if (last) els.objectKey.value = last;
  } catch {
    // localStorage can be unavailable in private mode; ignore.
  }
}

function setStatus(message, type) {
  els.status.textContent = type === "error" ? redact(String(message)) : String(message);
  els.status.className = "status show";
  if (type) els.status.classList.add(type);
}

// Upstream auth errors echo the API key back; don't paint it into the page.
function redact(text) {
  const key = els.apiKey.value.trim();
  return key ? text.split(key).join("•••••") : text;
}

function computeUtcOffsetLabel(zone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const offset = parts.find((part) => part.type === "timeZoneName")?.value;
    return offset ? offset.replace("GMT", "UTC") : "UTC";
  } catch {
    const minutes = -new Date().getTimezoneOffset();
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function timestampSlug() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
