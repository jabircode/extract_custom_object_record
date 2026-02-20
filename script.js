const form = document.getElementById("credentials-form");
const status = document.getElementById("status");
const results = document.getElementById("results");
const tableHead = document.getElementById("table-head");
const tableBody = document.getElementById("table-body");
const filterBar = document.getElementById("filter-bar");
const filterFieldSelect = document.getElementById("filter-field-select");
const filterValueMultiSelect = document.getElementById("filter-value-multiselect");
const filterValueToggle = document.getElementById("filter-value-toggle");
const filterValueDropdown = document.getElementById("filter-value-dropdown");
const filterValueLabel = document.getElementById("filter-value-label");
const filterRange = document.getElementById("filter-range");
const filterDateFrom = document.getElementById("filter-date-from");
const filterDateTo = document.getElementById("filter-date-to");
const resetFilterButton = document.getElementById("reset-filter");
const loader = document.getElementById("loader");
const downloadButton = document.getElementById("download-csv");
const importButton = document.getElementById("import-contact-list");
const paginationBar = document.getElementById("pagination");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageInfo = document.getElementById("page-info");
const pageSizeSelect = document.getElementById("page-size");

let originalRecords = [];
let filteredRecords = [];
let headersCache = [];
let currentPage = 1;
let pageSize = parseInt(pageSizeSelect?.value || "100", 10);
let currentApiKey = "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const apiKey = form.apiKey.value.trim();
  const objectKey = form.objectKey.value.trim();

  status.className = "status show";

  if (!apiKey || !objectKey) {
    return setStatus("Both fields are required.", "error");
  }

  currentApiKey = apiKey;
  setStatus("Fetching records…", "pending");
  showLoader(true);
  results.style.display = "none";
  filterBar.style.display = "none";
  if (downloadButton) downloadButton.style.display = "none";
  if (importButton) {
    importButton.style.display = "none";
    importButton.disabled = true;
  }
  if (paginationBar) paginationBar.style.display = "none";

  try {
    const records = await fetchAllRecords({ apiKey, objectKey });
    if (!records.length) {
      setStatus("No records found.", "error");
      return;
    }
    originalRecords = records;
    filteredRecords = records;
    headersCache = computeHeaders(records);
    buildFilters(headersCache, records);
    currentPage = 1;
    renderCurrentPage();
    setStatus(`Loaded ${records.length} record${records.length === 1 ? "" : "s"}.`, "ok");
    if (downloadButton) downloadButton.style.display = "inline-flex";
    if (importButton) importButton.style.display = "inline-flex";
    if (paginationBar) paginationBar.style.display = "flex";
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Failed to fetch records.", "error");
  } finally {
    showLoader(false);
  }
});

filterFieldSelect?.addEventListener("change", () => {
  handleFieldChange(filterFieldSelect.value, originalRecords);
  applyFilter();
});

filterValueToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  filterValueMultiSelect?.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (filterValueMultiSelect && !filterValueMultiSelect.contains(e.target)) {
    filterValueMultiSelect.classList.remove("open");
  }
});

resetFilterButton?.addEventListener("click", () => {
  if (!headersCache.length) return;
  filterFieldSelect.value = headersCache[0];
  populateValueOptions(filterFieldSelect.value, originalRecords);
  clearDateRange();
  filteredRecords = originalRecords;
  currentPage = 1;
  renderCurrentPage();
  setStatus(`Showing ${originalRecords.length} record${originalRecords.length === 1 ? "" : "s"}.`, "ok");
});

downloadButton?.addEventListener("click", () => {
  if (!filteredRecords.length) return;
  downloadCsv(filteredRecords, headersCache);
});

importButton?.addEventListener("click", async () => {
  const userProfileIds = getFilteredUserProfileIds();
  if (!userProfileIds.length) {
    return setStatus("No referencedUserProfileId values found in filtered records.", "error");
  }

  const groupListName = prompt("Enter contact list name");
  if (!groupListName || !groupListName.trim()) {
    return setStatus("Contact list name is required.", "error");
  }

  if (!currentApiKey) {
    return setStatus("API key missing. Please reload records.", "error");
  }

  importButton.disabled = true;
  setStatus(`Creating contact list "${groupListName.trim()}"…`, "pending");
  showLoader(true);

  try {
    const res = await fetch("/api/contact/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: currentApiKey,
        groupListName: groupListName.trim(),
        userProfileIds
      })
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `Request failed (${res.status})`);
    }

    setStatus(`Contact list "${groupListName.trim()}" created with ${userProfileIds.length} profile${userProfileIds.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Failed to create contact list.", "error");
  } finally {
    importButton.disabled = false;
    showLoader(false);
  }
});

prevPageBtn?.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderCurrentPage();
  }
});

nextPageBtn?.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  if (currentPage < totalPages) {
    currentPage += 1;
    renderCurrentPage();
  }
});

pageSizeSelect?.addEventListener("change", () => {
  const newSize = parseInt(pageSizeSelect.value, 10);
  if (!Number.isNaN(newSize) && newSize > 0) {
    pageSize = newSize;
    currentPage = 1;
    renderCurrentPage();
  }
});

filterDateFrom?.addEventListener("change", applyFilter);
filterDateTo?.addEventListener("change", applyFilter);

function setStatus(message, type) {
  status.textContent = message;
  status.className = "status show";
  if (type === "ok") status.classList.add("ok");
  if (type === "error") status.classList.add("error");
}

function showLoader(isVisible) {
  if (!loader) return;
  loader.classList.toggle("show", isVisible);
}

async function fetchAllRecords({ apiKey, objectKey }) {
  const all = [];
  let continuationToken = "";

  // Avoid infinite loops; hard cap pages.
  const maxLoops = 50;
  let loops = 0;

  while (loops < maxLoops) {
    loops += 1;
    const { records, nextContinuationToken } = await fetchPage({ apiKey, objectKey, continuationToken });
    if (Array.isArray(records) && records.length) {
      all.push(...records);
    }
    if (!nextContinuationToken) break;
    continuationToken = nextContinuationToken;
  }

  return all;
}

async function fetchPage({ apiKey, objectKey, continuationToken }) {
  const res = await fetch("/api/records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      apiKey,
      objectKey,
      continuationToken: continuationToken || ""
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status}): ${text || res.statusText}`);
  }

  const data = await res.json();
  return {
    records: data.records || [],
    nextContinuationToken: data.nextContinuationToken
  };
}

function computeHeaders(records) {
  const headers = new Set(["primaryPropertyValue", "referencedUserProfileId", "createdAt", "updatedAt"]);
  records.forEach(r => {
    if (r && r.propertyValues && typeof r.propertyValues === "object") {
      Object.keys(r.propertyValues).forEach(key => headers.add(key));
    }
  });
  return Array.from(headers);
}

function renderCurrentPage() {
  const headers = headersCache.length ? headersCache : computeHeaders(filteredRecords);
  tableHead.innerHTML = "";
  const headRow = document.createElement("tr");
  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  });
  tableHead.appendChild(headRow);

  const total = filteredRecords.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;

  const startIdx = (currentPage - 1) * pageSize;
  const pageRecords = filteredRecords.slice(startIdx, startIdx + pageSize);

  tableBody.innerHTML = "";
  pageRecords.forEach(r => {
    const tr = document.createElement("tr");
    headers.forEach(h => {
      const td = document.createElement("td");
      td.textContent = getFieldValue(r, h);
      tr.appendChild(td);
    });
    tableBody.appendChild(tr);
  });

  updatePaginationUI({ total, totalPages, startIdx, count: pageRecords.length });
  results.style.display = "block";
  updateImportButtonState();
}

function updatePaginationUI({ total, totalPages, startIdx, count }) {
  const startDisplay = total === 0 ? 0 : startIdx + 1;
  const endDisplay = startIdx + count;
  if (pageInfo) {
    pageInfo.textContent = `Showing ${startDisplay}-${endDisplay} of ${total} • Page ${currentPage}/${totalPages}`;
  }
  if (prevPageBtn) prevPageBtn.disabled = currentPage <= 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage >= totalPages;
}

function getFieldValue(record, field) {
  if (field === "primaryPropertyValue") return record?.primaryPropertyValue ?? "";
  if (field === "referencedUserProfileId") return record?.referencedUserProfileId ?? "";
  if (field === "createdAt") return record?.createdAt ?? "";
  if (field === "updatedAt") return record?.updatedAt ?? "";
  return record?.propertyValues?.[field] ?? "";
}

function buildFilters(headers, records) {
  if (!headers.length) {
    filterBar.style.display = "none";
    return;
  }

  filterFieldSelect.innerHTML = "";
  headers.forEach(h => {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h;
    filterFieldSelect.appendChild(opt);
  });

  filterFieldSelect.value = headers[0];
  handleFieldChange(headers[0], records);
  filterBar.style.display = "flex";
}

function populateValueOptions(field, records) {
  const values = new Set();
  records.forEach(r => {
    const value = getFieldValue(r, field);
    if (value !== null && value !== undefined && value !== "") {
      values.add(String(value));
    }
  });
  const sortedValues = Array.from(values).sort((a, b) => a.localeCompare(b));

  filterValueDropdown.innerHTML = "";

  // "All" checkbox — checks/unchecks every other item
  const allItem = createCheckboxItem("__ALL__", "All", true);
  const allCb = allItem.querySelector("input");
  allCb.addEventListener("change", () => {
    filterValueDropdown.querySelectorAll("input[type='checkbox']").forEach(cb => {
      cb.checked = allCb.checked;
    });
    updateMultiSelectLabel();
    applyFilter();
  });
  filterValueDropdown.appendChild(allItem);

  sortedValues.forEach(v => {
    const item = createCheckboxItem(v, v, true);
    const cb = item.querySelector("input");
    cb.addEventListener("change", () => {
      // Sync the "All" checkbox to reflect whether every value is checked
      const valueBoxes = filterValueDropdown.querySelectorAll("input[type='checkbox']:not([value='__ALL__'])");
      allCb.checked = Array.from(valueBoxes).every(b => b.checked);
      updateMultiSelectLabel();
      applyFilter();
    });
    filterValueDropdown.appendChild(item);
  });

  updateMultiSelectLabel();
}

function createCheckboxItem(value, label, checked) {
  const item = document.createElement("label");
  item.className = "multi-select-item";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.value = value;
  cb.checked = checked;
  const text = document.createElement("span");
  text.textContent = label;
  item.appendChild(cb);
  item.appendChild(text);
  return item;
}

function getSelectedValues() {
  if (!filterValueDropdown) return null;
  const allCb = filterValueDropdown.querySelector("input[value='__ALL__']");
  if (allCb?.checked) return null; // null → show all records
  const selected = [];
  filterValueDropdown.querySelectorAll("input[type='checkbox']:not([value='__ALL__'])").forEach(cb => {
    if (cb.checked) selected.push(cb.value);
  });
  return selected;
}

function updateMultiSelectLabel() {
  if (!filterValueLabel || !filterValueDropdown) return;
  const allCb = filterValueDropdown.querySelector("input[value='__ALL__']");
  if (allCb?.checked) {
    filterValueLabel.textContent = "All";
    return;
  }
  const selected = [];
  filterValueDropdown.querySelectorAll("input[type='checkbox']:not([value='__ALL__'])").forEach(cb => {
    if (cb.checked) selected.push(cb.value);
  });
  if (selected.length === 0) {
    filterValueLabel.textContent = "None";
  } else if (selected.length === 1) {
    filterValueLabel.textContent = selected[0];
  } else {
    filterValueLabel.textContent = `${selected.length} selected`;
  }
}

function applyFilter() {
  if (!originalRecords.length) return;
  const field = filterFieldSelect.value;
  if (!field) return;

  let filtered;

  if (isDateField(field)) {
    const fromVal = filterDateFrom?.value;
    const toVal = filterDateTo?.value;
    const from = fromVal ? Date.parse(fromVal) : null;
    const to = toVal ? Date.parse(toVal) : null;

    filtered = originalRecords.filter(r => {
      const ts = Date.parse(getFieldValue(r, field));
      if (Number.isNaN(ts)) return false;
      if (from !== null && ts < from) return false;
      if (to !== null && ts > to) return false;
      return true;
    });
  } else {
    const selectedValues = getSelectedValues();
    if (selectedValues === null || selectedValues.length === 0) {
      filtered = originalRecords;
    } else {
      filtered = originalRecords.filter(r => selectedValues.includes(getFieldValue(r, field)));
    }
  }

  filteredRecords = filtered;
  currentPage = 1;
  renderCurrentPage();
  setStatus(`Showing ${filtered.length} of ${originalRecords.length} record${originalRecords.length === 1 ? "" : "s"}.`, "ok");
}

function handleFieldChange(field, records) {
  if (isDateField(field)) {
    if (filterValueMultiSelect) filterValueMultiSelect.style.display = "none";
    filterRange.style.display = "flex";
    clearDateRange();
  } else {
    if (filterValueMultiSelect) filterValueMultiSelect.style.display = "block";
    filterRange.style.display = "none";
    populateValueOptions(field, records);
  }
}

function clearDateRange() {
  if (filterDateFrom) filterDateFrom.value = "";
  if (filterDateTo) filterDateTo.value = "";
}

function isDateField(field) {
  return field === "createdAt" || field === "updatedAt";
}

function downloadCsv(records, headers) {
  const cols = headers && headers.length ? headers : computeHeaders(records);
  const escape = (val) => {
    if (val === null || val === undefined) return "";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const lines = [];
  lines.push(cols.map(escape).join(","));

  records.forEach(r => {
    const row = cols.map(col => escape(getFieldValue(r, col)));
    lines.push(row.join(","));
  });

  const csv = lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `records-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getFilteredUserProfileIds() {
  const ids = new Set();
  filteredRecords.forEach(record => {
    const id = record?.referencedUserProfileId;
    if (id) ids.add(String(id));
  });
  return Array.from(ids);
}

function updateImportButtonState() {
  if (!importButton) return;
  const count = getFilteredUserProfileIds().length;
  importButton.disabled = count === 0;
  importButton.title = count === 0 ? "No referencedUserProfileId values found in filtered records." : "";
}
