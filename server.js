import express from 'express';
import session from 'express-session';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

const RC_CLIENT_ID = process.env.RC_CLIENT_ID;
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

let cachedProfiles = null;
let cacheTime = 0;

const CUSTOM_PROFILES = [
  {
    id: 'custom-1',
    first_name: 'xaesit',
    image_path: '/faces/xaesit.jpg',
    pronouns: 'he/him',
    role: 'current',
  },
];

const getRoleFromStints = (stints = []) => {
  if (stints.some((s) => s.type === 'employment' && s.in_progress)) return 'faculty';
  if (stints.some((s) => s.type === 'retreat' && s.in_progress)) return 'current';
  return 'alumni';
};

const fetchProfiles = async (token, offset, limit) => {
  const response = await fetch(
    `https://www.recurse.com/api/v1/profiles?scope=current&limit=${limit}&offset=${offset}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  return response.json();
};

const fetchAllProfiles = async (token) => {
  let allProfiles = [];
  let offset = 0;
  const limit = 50;
  let totalCount = Infinity;

  while (offset < totalCount) {
    const data = await fetchProfiles(token, offset, limit);
    if (data.length === 0) break;

    if (totalCount === Infinity && data[0]?.results_count !== undefined) {
      totalCount = data[0].results_count;
    }

    allProfiles = allProfiles.concat(
      data.map(({ id, first_name, image_path, pronouns, stints }) => ({
        id,
        first_name,
        image_path,
        pronouns,
        role: getRoleFromStints(stints),
      })),
    );
    offset += limit;

    if (data.length < limit) break;
  }

  return allProfiles;
};

const fetchRecentVisitorProfiles = async (token, existingIds) => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 2);
  const startDateStr = startDate.toISOString().split('T')[0];

  const response = await fetch(
    `https://www.recurse.com/api/v1/hub_visits?start_date=${startDateStr}&per_page=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Visits status: ${response.status}`);
  const visits = await response.json();

  const existingIdSet = new Set(existingIds);
  const visitorIds = [...new Set(visits.map((v) => v.person.id))].filter(
    (id) => !existingIdSet.has(id),
  );

  const profiles = await Promise.all(
    visitorIds.map(async (id) => {
      const r = await fetch(`https://www.recurse.com/api/v1/profiles/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const { id: pid, first_name, image_path, pronouns, stints } = await r.json();
      return { id: pid, first_name, image_path, pronouns, role: getRoleFromStints(stints) };
    }),
  );

  return profiles.filter(Boolean);
};

const app = express();

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 400 * 24 * 60 * 60 * 1000 },
  }),
);

app.use(express.static(join(__dirname, 'public')));

app.get('/auth/login', (req, res) => {
  if (!RC_CLIENT_ID) {
    return res.status(500).send('RC_CLIENT_ID not configured');
  }
  const state = randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: RC_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
  });
  res.redirect(`https://www.recurse.com/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid state parameter');
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch('https://www.recurse.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: RC_CLIENT_ID,
        client_secret: RC_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('Token exchange failed:', body);
      return res.status(500).send('Failed to exchange authorization code for token');
    }

    const tokenData = await tokenRes.json();
    req.session.token = tokenData.access_token;

    const meRes = await fetch('https://www.recurse.com/api/v1/profiles/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      req.session.userId = me.id;
    }

    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err);
    res.status(500).send('Authentication error');
  }
});

app.get('/api/directory', async (req, res) => {
  const token = req.session.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  console.log(token);

  if (cachedProfiles && Date.now() - cacheTime < CACHE_DURATION_MS) {
    return res.json(cachedProfiles.filter((p) => p.id !== req.session.userId));
  }

  try {
    const profiles = await fetchAllProfiles(token);
    const recentVisitors = await fetchRecentVisitorProfiles(
      token,
      profiles.map((p) => p.id),
    );
    cachedProfiles = [...profiles, ...recentVisitors, ...CUSTOM_PROFILES].filter(
      (p) => !p.image_path?.includes('no_photo'),
    );
    cacheTime = Date.now();
    res.setHeader('Cache-Control', `public, max-age=${6 * 60 * 60}`);
    res.json(cachedProfiles.filter((p) => p.id !== req.session.userId));
  } catch (err) {
    if (err.message.includes('401')) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Authentication expired' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
