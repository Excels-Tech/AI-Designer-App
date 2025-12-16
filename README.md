
  # AI Designer App UI

  This is a code bundle for AI Designer App UI. The original project is available at https://www.figma.com/design/PEBmq1BJmNQDKtWUHm0Gg6/AI-Designer-App-UI.

  ## Running the code locally

  - Run `npm install` to install the dependencies.
  - Run `npm run dev:all` to start both the Vite dev server (UI) and the API server.

  The API server listens on `http://localhost:8787` and the Vite dev server on `http://localhost:3000`.

  ## Environment variables

  Create a `.env` file in the project root with at least:

  - `GEMINI_API_KEY` – Google Gemini API key used for image generation.
  - `DATABASE_URL` – Postgres connection string (used for saving designs).

  Optional:

  - `DATABASE_SSL` – Set to `true` or `1` when your Postgres requires SSL (for example on Render).
  - `UPLOADS_ROOT` – Override the uploads directory (for example `/var/data/uploads` when using a persistent disk).

  ## Deploying to Render

  This repo includes a `render.yaml` that defines:

  - A Node web service that runs `npm run server` after running `npm run build`.
  - A Postgres database wired to `DATABASE_URL`.
  - Environment variables for `GEMINI_API_KEY`, `DATABASE_SSL`, and `UPLOADS_ROOT`.

  To deploy:

  1. Push this repo to GitHub.
  2. In Render, click "New" → "Blueprint" and point it at the GitHub repo.
  3. Set the `GEMINI_API_KEY` value in the Render dashboard (it is marked as `sync: false` in `render.yaml`).
  4. (Optional) Attach a persistent disk mapped to `/var/data` if you want uploaded images to persist across deploys.
  
