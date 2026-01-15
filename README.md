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

## Environment

- `GEMINI_API_KEY` - Google Gemini API key used server-side only. The key is never exposed to the client bundle.
- **Prompt Enhancer (backend-only, privacy-safe)**
  - Enhanced endpoints: `POST /api/generate-base`, `POST /api/generate-views-from-base`, `POST /api/generate-views`
  - Privacy guarantee: the refined prompt is used only for the model call and is never returned to the client, never stored, and never logged in production.
- `PROMPT_ENHANCER_ENABLED` - Enable backend-only prompt enhancement (default `true`; set to `false` to disable).
- `PROMPT_ENHANCER_DEBUG` - If `true` and `NODE_ENV` is not `production`, logs enhanced prompt for debugging (default `false`).
- `PROMPT_ENHANCER_MODEL_FORMAT` - Optional formatting hint: `sdxl` (default), `midjourney`, or `generic`.

## Key Features Added

- Backend `/api/generate-views` that calls `gemini-2.5-flash-image`, builds a composite prompt, and auto-crops the returned image into per-view PNGs using `sharp`.
- Frontend multi-view generator with resolution/style/view selectors, generates one composite, shows cropped results, and supports "Download All".
  
