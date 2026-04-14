# BuildAI — Free AI Website Builder

A free, open-source AI website builder powered by Gemini. Describe any website and get a complete, professional HTML/CSS/JS site in seconds.

## Deploy to Railway (recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo
4. In Railway, go to **Variables** → add:
   ```
   GOOGLE_API_KEY = your_key_here
   ```
   Optional for saved projects and Google sign-in:
   ```
   DATABASE_URL = your_postgres_connection_string
   GOOGLE_CLIENT_ID = your_google_oauth_client_id
   GOOGLE_CLIENT_SECRET = your_google_oauth_client_secret
   SESSION_SECRET = a_long_random_secret
   CALLBACK_URL = https://your-domain.com/auth/google/callback
   ```
5. Railway auto-deploys. Your site is live!

Get your Gemini API key from Google AI Studio.

## Run locally (requires Node.js)

```bash
npm install
cp .env.example .env
# Edit .env and add your GOOGLE_API_KEY
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
