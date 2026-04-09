# BuildAI — Free AI Website Builder

A free, open-source AI website builder powered by Claude. Describe any website and get a complete, professional HTML/CSS/JS site in seconds.

## Deploy to Railway (recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo
4. In Railway, go to **Variables** → add:
   ```
   ANTHROPIC_API_KEY = your_key_here
   ```
5. Railway auto-deploys. Your site is live!

Get your API key at: https://console.anthropic.com

## Run locally (requires Node.js)

```bash
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm start
```

Open http://localhost:4000

## Project structure

```
├── server.js          # Express server + Claude API proxy
├── package.json
├── .env.example       # Copy to .env and add your API key
└── public/
    ├── index.html     # Landing page
    └── builder.html   # AI website builder UI
```
