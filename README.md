# Custom Object Extractor

A small client + proxy to pull custom object records, handle continuation tokens, and view/filter/download them in the browser.

## Features
- User inputs API key and object key.
- Automatic base URL failover across Sleekflow regions; pins the first that returns 200.
- GET-with-body proxy to avoid CORS and URL length limits.
- Continuation token paging until exhaustion (hard cap 50 pages).
- Dynamic table headers from API response, including `referencedUserProfileId`, `createdAt`, `updatedAt`.
- Filters: value dropdowns for most fields; date-range filter for `createdAt`/`updatedAt`.
- Client-side pagination to keep UI responsive with large datasets.
- CSV export of the full fetched dataset (not just the current page).
- Inline loading indicator.

## Requirements
- Node.js 18+ (for native `fetch` in Node).

## Run locally
```bash
cd custom_object_extractor
node server.js
```
Then open `http://localhost:3000`.

## Usage 
1) Enter your API key and object key.  
2) Submit to fetch all pages (continuation tokens handled automatically).  
3) Use filters to narrow results; `createdAt`/`updatedAt` switch to a date range.  
4) Navigate pages with the pagination bar; adjust rows per page.  
5) Download all fetched records as CSV via the Download button.  

## Notes
- The proxy uses GET with a JSON body to match the upstream pattern; it retries base URLs in order and pins the first success for subsequent calls.  
- Pagination reduces DOM size; filtering applies to the full dataset but only the current page is rendered.  
- Loader shows during fetch to clarify progress.  
