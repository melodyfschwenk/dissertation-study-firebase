# AGENTS instructions

- Refer to `README.md` for installation, build/start commands, and environment variable setup.
- Run `npm run build` after modifying source files in `src/`.
- Run `npm run lint` before committing.
- Commit both the source files and the generated `main.js` artifact.
- Use 2 spaces for indentation; see `.editorconfig` (UTF-8 encoding) for editor settings.
- Check server logs for startup/runtime errors and ensure request and server errors are properly handled.
- Guard against missing critical configuration values at server startup, logging warnings on the backend so participants don't see them.
- The server refuses to start without `SHEETS_URL`, `CLOUDINARY_CLOUD_NAME`, and `CLOUDINARY_UPLOAD_PRESET`.
- Use `npm start` to launch the Node server and monitor logs for warnings or errors.
- Do not commit `.env`, `*.log`, or `.DS_Store` files; these are ignored.
- Upload metrics expect file sizes in kilobytes.
- Centralize Apps Script error handling with `handleError`, wrapping spreadsheet operations in try/catch.

## Module structure
The `src/` directory now separates concerns into:
- `config.js` – configuration constants and regexes
- `tasks.js` – task definitions and helpers
- `videoUpload.js` – video upload utilities
- `debug.js` – debugging helpers
