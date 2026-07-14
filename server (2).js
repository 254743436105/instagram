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
  const fetchHeaders = {
    'User-Agent':
      'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const res = await axios.get(pageUrl, {
    headers: fetchHeaders,
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

  let videoUrl = ogVideoSecure || ogVideo || null;
  let imageUrl = ogImage || null;

  // Reels frequently don't carry an og:video tag on the main post page at
  // all (only a thumbnail image). Instagram's /embed/ page renders an actual
  // <video> element with a real src, so fall back to that specifically for
  // reels when the primary page didn't give us a video.
  if (!videoUrl && /\/reels?\//.test(pageUrl)) {
    try {
      const embedRes = await axios.get(`${pageUrl}embed/`, {
        headers: fetchHeaders,
        timeout: 15000,
        validateStatus: (s) => s < 500,
      });
      const $embed = cheerio.load(embedRes.data);
      const videoTagSrc = $embed('video').attr('src');
      if (videoTagSrc) {
        videoUrl = videoTagSrc;
      } else {
        // Some embed responses keep the URL inside inline JSON rather than
        // a <video> tag. Look for a video_url field as a last resort.
        const match = String(embedRes.data).match(/"video_url":"([^"]+)"/);
        if (match) {
          videoUrl = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        } else {
          console.log('--- Yobih debug: embed page had no video ---');
          console.log('Embed status:', embedRes.status);
          console.log('Embed length:', embedRes.data.length);
          console.log('Embed title:', $embed('title').text());
          console.log('First 300 chars:', String(embedRes.data).slice(0, 300));
          console.log('----------------------------------------------');
        }
      }
    } catch (embedErr) {
      console.log('--- Yobih debug: embed fallback failed ---');
      console.log('Embed URL:', `${pageUrl}embed/`);
      console.log('Error:', embedErr.message);
      if (embedErr.response) {
        console.log('Embed status:', embedErr.response.status);
      }
      console.log('-------------------------------------------');
    }
  }

  // This is a reel and we still don't have a real video — don't silently
  // hand back the thumbnail image as if it were the download. That's
  // misleading: the person asked for a video and would get a still photo
  // with no indication anything went wrong.
  if (!videoUrl && /\/reels?\//.test(pageUrl)) {
    const err = new Error(
      'Couldn’t find the video for this reel — only a thumbnail was available. It may be region-locked or blocked from automated access.'
    );
    err.code = 'UNRESOLVED';
    throw err;
  }

  if (!videoUrl && !imageUrl) {
    console.log('--- Yobih debug: unresolved post ---');
    console.log('Status:', res.status);
    console.log('Response length:', res.data.length);
    console.log('Looks like a login page:', /name="password"/i.test(res.data));
    console.log('Title tag:', $('title').text());
    console.log('First 300 chars:', String(res.data).slice(0, 300));
    console.log('-------------------------------------');

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

// Instagram's CDN URLs are cross-origin, and browsers silently ignore the
// `download` attribute on cross-origin links — clicking just opens/plays the
// file instead of saving it. This endpoint streams the media back through
// our own origin with Content-Disposition: attachment so it actually downloads.
// Restricted to Instagram/Facebook CDN hosts only, so this can't be used as
// an open proxy for arbitrary URLs.
const ALLOWED_MEDIA_HOSTS = /\.(cdninstagram\.com|fbcdn\.net)$/i;

app.get('/api/download', async (req, res) => {
  const mediaUrl = req.query.url;
  const type = req.query.type === 'image' ? 'image' : 'video';

  if (!mediaUrl) {
    return res.status(400).json({ ok: false, error: 'Missing url.' });
  }

  let parsed;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid url.' });
  }

  if (!ALLOWED_MEDIA_HOSTS.test(parsed.hostname)) {
    return res.status(400).json({ ok: false, error: 'That host isn’t allowed.' });
  }

  try {
    const upstream = await axios.get(mediaUrl, {
      responseType: 'stream',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const ext = type === 'image' ? 'jpg' : 'mp4';
    const filename = `yobih-${Date.now()}.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader(
      'Content-Type',
      upstream.headers['content-type'] || (type === 'image' ? 'image/jpeg' : 'video/mp4')
    );
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    upstream.data.pipe(res);
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Couldn’t fetch that file. Try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Yobih running at http://localhost:${PORT}`);
});
