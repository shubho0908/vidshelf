# E2E scripts (playwright, manual)

Run a preview first: `npx vite preview --port 4173` (from app/), then
`node e2e/thumbs.e2e.mjs` etc. from app/.

WARNING: the app syncs against the live worker when run unmodified. Create
only throwaway "E2E ..." entries and delete them inside the script so
tombstones clean the cloud library. Do not commit real-library mutations.
