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

`npm run dev` starts both the Vite client (http://localhost:3000) and the Node/Express API (http://localhost:4000) with a proxy at `/api`.

To run everything (client + server + SAM2 microservice):
```bash
npm run dev:all
```

## SAM2 Service (Local)

The editor's color layer detection uses a local FastAPI service (`sam2_service`). It works in two modes:

- **SAM2 mode** (best): enabled only when you provide `SAM2_CONFIG` + `SAM2_CHECKPOINT`.
- **Fallback mode** (works out of the box): if SAM2 isn't configured, the service uses a lightweight KMeans-based color clustering fallback.

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

### SAM2 weights (optional)

This repo does not download SAM2 weights automatically. To enable SAM2 mode:

1. Download the SAM2 config + checkpoint files separately.
2. Set environment variables to point to your local files:
   ```bash
   # example (PowerShell)
   $env:SAM2_CONFIG="C:\\path\\to\\sam2_config.yaml"
   $env:SAM2_CHECKPOINT="C:\\path\\to\\sam2_checkpoint.pt"
   ```

You can store these files anywhere locally (for example `sam2_service/weights/`) as long as the env vars point to the correct paths.

## Environment

- `GEMINI_API_KEY` - Google Gemini API key used server-side only. The key is never exposed to the client bundle.
- `SAM2_SERVICE_URL` - Base URL for the SAM2 FastAPI service (default `http://127.0.0.1:8008`).
- `SAM2_CONFIG` - (optional) Path to SAM2 config file for the Python service.
- `SAM2_CHECKPOINT` - (optional) Path to SAM2 checkpoint weights for the Python service.
- **Prompt Enhancer (backend-only, privacy-safe)**
  - Enhanced endpoints: `POST /api/generate-base`, `POST /api/generate-views-from-base`, `POST /api/generate-views`
  - Privacy guarantee: the refined prompt is used only for the model call and is never returned to the client, never stored, and never logged in production.
- `PROMPT_ENHANCER_ENABLED` - Enable backend-only prompt enhancement (default `true`; set to `false` to disable).
- `PROMPT_ENHANCER_DEBUG` - If `true` and `NODE_ENV` is not `production`, logs enhanced prompt for debugging (default `false`).
- `PROMPT_ENHANCER_MODEL_FORMAT` - Optional formatting hint: `sdxl` (default), `midjourney`, or `generic`.

## Key Features Added

- Backend `/api/generate-views` that calls `gemini-2.5-flash-image`, builds a composite prompt, and auto-crops the returned image into per-view PNGs using `sharp`.
- Frontend multi-view generator with resolution/style/view selectors, generates one composite, shows cropped results, and supports "Download All".
  
