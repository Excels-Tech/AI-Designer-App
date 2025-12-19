# AI Designer App UI

This is a code bundle for AI Designer App UI. The original project is available at https://www.figma.com/design/PEBmq1BJmNQDKtWUHm0Gg6/AI-Designer-App-UI.

## Setup

1. Install dependencies
   ```bash
   npm install
   ```
2. Copy env template and add your Gemini key
   ```bash
   cp .env.example .env
   # set GEMINI_API_KEY=...
   ```
3. Provide Mongo connection (for saving designs)
   ```
   # in .env
   MONGODB_URI=mongodb://localhost:27017/ai-designer
   ```

## Development

Start the SAM2 service first (see "SAM2 Service (Local)" below), then run the app.

`npm run dev` starts both the Vite client (http://localhost:3000) and the Node/Express API (http://localhost:4000) with a proxy at `/api`.

To run everything including the SAM2 service:
```bash
npm run dev:all
```

## SAM2 Service (Local)

The color layer detection uses a local FastAPI service backed by SAM2.

1. `cd sam2_service`
2. `python -m venv .venv`
3. Activate the environment:
   ```bash
   # Windows (PowerShell)
   .venv\Scripts\Activate.ps1

   # macOS/Linux
   source .venv/bin/activate
   ```
4. `python -m pip install -r requirements.txt`
5. Start the service:
   ```bash
   python -m uvicorn app:app --host 0.0.0.0 --port 8008
   ```

## Environment

- `GEMINI_API_KEY` - Google Gemini API key used server-side only. The key is never exposed to the client bundle.
- `SAM2_SERVICE_URL` - Base URL for the SAM2 FastAPI service (default `http://127.0.0.1:8008`).

## Key Features Added

- Backend `/api/generate-views` that calls `gemini-2.5-flash-image`, builds a composite prompt, and auto-crops the returned image into per-view PNGs using `sharp`.
- Frontend multi-view generator with resolution/style/view selectors, generates one composite, shows cropped results, and supports "Download All".
  
