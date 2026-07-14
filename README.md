# Yobih

A small Instagram downloader: paste a public post/reel/IGTV link, get the photo or video back.

## How it works

Instagram serves Open Graph tags (`og:video`, `og:image`) on public post pages so that
link previews render on other apps. Yobih's server fetches the post page with a
preview-bot user agent and reads those tags — the same data anyone gets by opening
the link and viewing "page source." No login, no private API, no scraping of anything
that isn't already public.

**Limitations, by design:**
- Only works on **public** posts, reels, and IGTV. Private accounts return an error,
  same as if you opened the link in a logged-out browser.
- Stories and highlights aren't supported (they require a session to view at all).
- If Instagram changes their markup, the `og:` tag selectors in `server.js` may need
  updating.
- Be a good citizen: this is for saving your own content or things you have permission
  to reuse, not for mass-scraping or reposting other creators' work.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Deploy

Works on Render, Railway, or Heroku with zero config — it's a standard Node/Express app.

- **Start command:** `node server.js`
- **Port:** reads `process.env.PORT` automatically, so no extra setup needed.
- No environment variables or database required.

## Project structure

```
yobih/
├── server.js        # Express API — POST /api/resolve { url }
├── public/
│   └── index.html   # frontend (single file, no build step)
├── package.json
└── README.md
```
