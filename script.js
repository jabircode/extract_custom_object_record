const form = document.getElementById("credentials-form");
const status = document.getElementById("status");
const results = document.getElementById("results");
const tableHead = document.getElementById("table-head");
const tableBody = document.getElementById("table-body");
const filterBar = document.getElementById("filter-bar");
const filterFieldSelect = document.getElementById("filter-field-select");
const filterValueSelect = document.getElementById("filter-value-select");
const filterRange = document.getElementById("filter-range");
const filterDateFrom = document.getElementById("filter-date-from");
const filterDateTo = document.getElementById("filter-date-to");
const resetFilterButton = document.getElementById("reset-filter");
const loader = document.getElementById("loader");
const downloadButton = document.getElementById("download-csv");
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const apiKey = form.apiKey.value.trim();
  const objectKey = form.objectKey.value.trim();

  status.className = "status show";

  if (!apiKey || !objectKey) {
    return setStatus("Both fields are required.", "error");
  }

  setStatus("Fetching records…", "pending");
  showLoader(true);
  results.style.display = "none";
  filterBar.style.display = "none";
  if (downloadButton) downloadButton.style.display = "none";
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

filterValueSelect?.addEventListener("change", applyFilter);

resetFilterButton?.addEventListener("click", () => {
  if (!headersCache.length) return;
  filterFieldSelect.value = headersCache[0];
  populateValueOptions(filterFieldSelect.value, originalRecords, true);
  clearDateRange();
  filteredRecords = originalRecords;
  currentPage = 1;
  renderCurrentPage();
  setStatus(`Showing ${originalRecords.length} record${originalRecords.length === 1 ? "" : "s"}.`, "ok");
});

downloadButton?.addEventListener("click", () => {
  if (!originalRecords.length) return;
  downloadCsv(originalRecords, headersCache);
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

function populateValueOptions(field, records, selectAll = false) {
  const values = new Set();
  records.forEach(r => {
    const value = getFieldValue(r, field);
    if (value !== null && value !== undefined && value !== "") {
      values.add(String(value));
    }
  });
  const sortedValues = Array.from(values).sort((a, b) => a.localeCompare(b));

  filterValueSelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "__ALL__";
  allOpt.textContent = "All";
  filterValueSelect.appendChild(allOpt);

  sortedValues.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    filterValueSelect.appendChild(opt);
  });

  filterValueSelect.value = selectAll ? "__ALL__" : (filterValueSelect.value || "__ALL__");
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
    const value = filterValueSelect.value;
    filtered = value === "__ALL__"
      ? originalRecords
      : originalRecords.filter(r => getFieldValue(r, field) === value);
  }

  filteredRecords = filtered;
  currentPage = 1;
  renderCurrentPage();
  setStatus(`Showing ${filtered.length} of ${originalRecords.length} record${originalRecords.length === 1 ? "" : "s"}.`, "ok");
}

function handleFieldChange(field, records) {
  if (isDateField(field)) {
    filterValueSelect.style.display = "none";
    filterRange.style.display = "flex";
    clearDateRange();
  } else {
    filterValueSelect.style.display = "block";
    filterRange.style.display = "none";
    populateValueOptions(field, records, true);
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
