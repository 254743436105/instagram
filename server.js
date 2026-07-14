const express = require('express');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const IG_URL_RE = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

function normalizeUrl(raw) {
  const match = raw.trim().match(IG_URL_RE);
  if (!match) return null;
  const kind = match[2];
  const code = match[3];
  return `https://www.instagram.com/${kind}/${code}/`;
}

// Resolves a public Instagram post/reel URL to its underlying media by reading
// the page's Open Graph tags (the same tags Instagram serves to link-preview
// bots). This only works for public, non-age-gated posts — Instagram requires
// a logged-in session to view anything else, and Yobih does not attempt to
// authenticate, bypass logins, or access private content.
async function resolveMedia(pageUrl) {
  const res = await axios.get(pageUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
    validateStatus: (s) => s < 500,
  });

  if (res.status === 404) {
    const err = new Error('That post doesn’t exist, or the link is off.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const $ = cheerio.load(res.data);
  const ogVideo = $('meta[property="og:video"]').attr('content');
  const ogVideoSecure = $('meta[property="og:video:secure_url"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDescription = $('meta[property="og:description"]').attr('content');

  const videoUrl = ogVideoSecure || ogVideo || null;
  const imageUrl = ogImage || null;

  if (!videoUrl && !imageUrl) {
    const err = new Error(
      'Couldn’t read this post. It may be private, age-restricted, or region-locked.'
    );
    err.code = 'UNRESOLVED';
    throw err;
  }

  return {
    type: videoUrl ? 'video' : 'image',
    mediaUrl: videoUrl || imageUrl,
    thumbnail: ogImage || null,
    title: ogTitle || null,
    caption: ogDescription || null,
  };
}

app.post('/api/resolve', async (req, res) => {
  const raw = (req.body && req.body.url) || '';
  const pageUrl = normalizeUrl(raw);

  if (!pageUrl) {
    return res.status(400).json({
      ok: false,
      error: 'That doesn’t look like an Instagram post, reel, or IGTV link.',
    });
  }

  try {
    const media = await resolveMedia(pageUrl);
    return res.json({ ok: true, source: pageUrl, ...media });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 422;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Yobih running at http://localhost:${PORT}`);
});
