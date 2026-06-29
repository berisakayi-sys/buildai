# BuildAI — Free AI Website Builder

A free, open-source AI website builder powered by OpenRouter. Describe any website and get a complete, professional HTML/CSS/JS site in seconds.

## Deploy to Railway (recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo
4. In Railway, go to **Variables** → add:
   ```
   OPENROUTER_API_KEY = your_key_here
   OPENROUTER_MODEL = qwen/qwen3-coder:free
   ```
5. Railway auto-deploys. Your site is live!

Get your OpenRouter API key from OpenRouter.

## Run locally (requires Node.js)

```bash
npm install
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY and OPENROUTER_MODEL
npm start
```

Open http://localhost:8080

If Node.js is not installed, you can still preview the site with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1
```

## Project structure

```
├── server.js          # Express server + Claude API proxy
├── package.json
├── .env.example       # Copy to .env and add your API key
└── public/
    ├── index.html     # Landing page
    └── builder.html   # AI website builder UI
```
