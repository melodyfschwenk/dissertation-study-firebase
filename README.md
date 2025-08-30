# Dissertation Study

This project collects video upload data for a dissertation study.

## Installation

Install dependencies:

```bash
npm install
```

## Build

Compile source files in `src/` to `main.js`:

```bash
npm run build
```

Run this after any changes to files in `src/`.

## Start

Start the Node server:

```bash
npm start
```

Check the console for warnings or errors during startup.

## Environment variables

Create a `.env` file or export these variables before running the server:

```
SHEETS_URL=<Google Sheets endpoint>
CLOUDINARY_CLOUD_NAME=<Cloudinary cloud name>
CLOUDINARY_UPLOAD_PRESET=<Cloudinary upload preset>
PORT=<optional port, defaults to 3000>
```

Do not commit the `.env` file to version control.

## Firebase configuration

Create `public/firebase-config.js` by copying `public/firebase-config.example.js` and filling in your Firebase project details. This file is ignored by Git so your API key remains private.
