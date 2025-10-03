const http = require('http');
const { randomUUID, createHash } = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret';

const ACCESS_TTL = 15 * 60 * 1000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;

const db = {
  authRequests: new Map(),
  users: new Map(),
  profiles: new Map(),
  locations: new Map(),
  swipes: [],
  matches: new Map(),
  messages: new Map(),
  reviews: [],
  reputations: new Map(),
  places: new Map(),
  abuseReports: [],
  payments: [],
  auditLogs: [],
  featureFlags: new Map()
};

const products = [
  { id: 'pro_week', price: 49900, currency: 'RUB', durationDays: 7 },
  { id: 'pro_month', price: 129900, currency: 'RUB', durationDays: 30 },
  { id: 'pro_year', price: 999900, currency: 'RUB', durationDays: 365 }
];

const eveningStyles = ['тихо', 'настолки', 'бар-тур', 'пати'];
const defaultTopics = ['политика', 'детство', 'коты', 'бывшие', 'кино', 'игры', 'музыка', 'путешествия', 'ни о чём, но душевно'];

const tokens = {
  access: new Map(),
  refresh: new Map()
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function matchRoute(pattern, actual) {
  if (pattern === actual) {
    return { matched: true, params: {} };
  }
  const patternParts = pattern.split('/').filter(Boolean);
  const actualParts = actual.split('/').filter(Boolean);
  if (patternParts.length !== actualParts.length) {
    return { matched: false };
  }
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    const actualPart = actualParts[i];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(actualPart);
    } else if (patternPart !== actualPart) {
      return { matched: false };
    }
  }
  return { matched: true, params };
}

function issueTokens(userId) {
  const now = Date.now();
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  tokens.access.set(accessToken, { userId, expiresAt: now + ACCESS_TTL });
  tokens.refresh.set(refreshToken, { userId, expiresAt: now + REFRESH_TTL });
  return { accessToken, refreshToken };
}

function rotateAccessToken(refreshToken) {
  const entry = tokens.refresh.get(refreshToken);
  if (!entry || entry.expiresAt < Date.now()) {
    return null;
  }
  const accessToken = randomUUID();
  tokens.access.set(accessToken, { userId: entry.userId, expiresAt: Date.now() + ACCESS_TTL });
  return { accessToken };
}

function authenticate(req) {
  const header = req.headers['authorization'];
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  const entry = tokens.access.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    return null;
  }
  const user = db.users.get(entry.userId);
  if (!user || user.status === 'banned') {
    return null;
  }
  return user;
}

function ensureUserProfile(userId) {
  if (!db.profiles.has(userId)) {
    db.profiles.set(userId, {
      userId,
      nickname: `user_${userId.slice(-4)}`,
      bio: '',
      favoriteDrink: 'просекко',
      haveAtHome: [],
      bringWithYou: [],
      talkTopics: defaultTopics.slice(0, 3),
      photos: [],
      moodTags: []
    });
  }
  if (!db.locations.has(userId)) {
    db.locations.set(userId, {
      userId,
      lat: 55.751244,
      lon: 37.618423,
      city: 'Москва',
      lastSeenAt: new Date().toISOString(),
      visibilityMode: 'visible',
      searchRadiusM: 3000
    });
  }
  if (!db.reputations.has(userId)) {
    db.reputations.set(userId, {
      userId,
      avgWarmth: 0,
      avgSanity: 0,
      avgStamina: 0,
      badges: [],
      score: 0
    });
  }
}

function hashPhone(phone) {
  return createHash('sha256').update(phone).digest('hex');
}

function seed() {
  const demoUserId = randomUUID();
  db.users.set(demoUserId, {
    id: demoUserId,
    phoneHash: hashPhone('+79999999999'),
    age: 29,
    gender: 'male',
    createdAt: new Date().toISOString(),
    status: 'active',
    isPro: false,
    proExpiresAt: null,
    kycStatus: 'pending'
  });
  ensureUserProfile(demoUserId);
  const profile = db.profiles.get(demoUserId);
  profile.nickname = 'Антон';
  profile.favoriteDrink = 'просекко';
  profile.talkTopics = ['настолки', 'котики'];
  profile.moodTags = ['душевно на кухне'];
  profile.photos = ['https://example.com/photo1.jpg'];
  const location = db.locations.get(demoUserId);
  location.lat = 55.751244;
  location.lon = 37.618423;

  const otherUserIds = Array.from({ length: 10 }).map(() => randomUUID());
  otherUserIds.forEach((id, idx) => {
    db.users.set(id, {
      id,
      phoneHash: hashPhone(`+7999000000${idx}`),
      age: 22 + idx,
      gender: idx % 2 === 0 ? 'female' : 'male',
      createdAt: new Date().toISOString(),
      status: 'active',
      isPro: idx % 3 === 0,
      proExpiresAt: null,
      kycStatus: 'approved'
    });
    ensureUserProfile(id);
    const prof = db.profiles.get(id);
    prof.nickname = `Пользователь ${idx + 1}`;
    prof.favoriteDrink = idx % 2 === 0 ? 'вино' : 'пиво';
    prof.talkTopics = defaultTopics.slice(idx % defaultTopics.length, (idx % defaultTopics.length) + 3);
    prof.moodTags = [eveningStyles[idx % eveningStyles.length]];
    prof.photos = [`https://example.com/u${idx + 1}.jpg`];
    const loc = db.locations.get(id);
    loc.lat = 55.75 + Math.random() * 0.05;
    loc.lon = 37.6 + Math.random() * 0.05;
    loc.city = 'Москва';
    loc.visibilityMode = 'visible';
  });
}

function paginate(array, page = 1, pageSize = 20) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const items = array.slice(start, end);
  const nextPage = end < array.length ? page + 1 : null;
  return { items, nextPage };
}

function toPublicProfile(userId) {
  const user = db.users.get(userId);
  const profile = db.profiles.get(userId);
  const reputation = db.reputations.get(userId) || { score: 0, badges: [], avgWarmth: 0, avgSanity: 0, avgStamina: 0 };
  if (!user || !profile) {
    return null;
  }
  return {
    user_id: user.id,
    nickname: profile.nickname,
    favorite_drink: profile.favoriteDrink,
    talk_topics: profile.talkTopics,
    mood_tags: profile.moodTags,
    photos: profile.photos,
    reputation: {
      score: Number(reputation.score.toFixed(2)),
      badges: reputation.badges
    }
  };
}

function computeDistanceMeters(a, b) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2), Math.sqrt(1 - (sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2)));
  return Math.round(R * c);
}

function summariseReputation(userId) {
  const userReviews = db.reviews.filter(r => r.revieweeId === userId);
  if (userReviews.length === 0) {
    db.reputations.set(userId, {
      userId,
      avgWarmth: 0,
      avgSanity: 0,
      avgStamina: 0,
      badges: [],
      score: 0
    });
    return;
  }
  const totals = userReviews.reduce((acc, review) => {
    acc.warmth += review.scales.warmth;
    acc.sanity += review.scales.sanity;
    acc.stamina += review.scales.stamina;
    return acc;
  }, { warmth: 0, sanity: 0, stamina: 0 });
  const avgWarmth = totals.warmth / userReviews.length;
  const avgSanity = totals.sanity / userReviews.length;
  const avgStamina = totals.stamina / userReviews.length;
  const score = (avgWarmth + avgSanity + avgStamina) / 3;
  const badges = [];
  if (avgWarmth >= 4.5) badges.push('🍷 «Душа компании»');
  if (avgStamina >= 4.5) badges.push('🥃 «Не закусывает, но держится»');
  if (avgSanity >= 4.5) badges.push('🍸 «Слушатель 5/5»');
  db.reputations.set(userId, {
    userId,
    avgWarmth,
    avgSanity,
    avgStamina,
    badges,
    score
  });
}

function requireAdmin(req) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) {
    return false;
  }
  return true;
}

function buildModerationQueue() {
  const queue = [];
  db.users.forEach(user => {
    if (user.status === 'pending_review') {
      queue.push({ type: 'user', id: user.id, status: 'pending' });
    }
  });
  db.places.forEach(place => {
    if (place.status === 'pending') {
      queue.push({ type: 'place', id: place.id, status: 'pending', title: place.title });
    }
  });
  db.reviews.forEach(review => {
    if (review.status === 'pending') {
      queue.push({ type: 'review', id: review.id, status: 'pending' });
    }
  });
  return queue;
}

const routes = [];

function register(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

register('OPTIONS', '*', async (req, res) => {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end();
});

register('POST', '/v1/auth/request_code', async (req, res) => {
  try {
    const body = await readBody(req);
    const phone = String(body.phone || '').trim();
    if (!phone) {
      sendJson(res, 400, { error: 'phone_required' });
      return;
    }
    const requestId = randomUUID();
    const code = String(Math.floor(1000 + Math.random() * 9000));
    db.authRequests.set(requestId, {
      phone,
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0
    });
    sendJson(res, 200, { request_id: requestId, mock_code: code });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('POST', '/v1/auth/verify_code', async (req, res) => {
  try {
    const body = await readBody(req);
    const { request_id: requestId, code } = body;
    const entry = db.authRequests.get(requestId);
    if (!entry) {
      sendJson(res, 400, { error: 'request_not_found' });
      return;
    }
    if (entry.expiresAt < Date.now()) {
      db.authRequests.delete(requestId);
      sendJson(res, 400, { error: 'code_expired' });
      return;
    }
    entry.attempts += 1;
    if (entry.code !== String(code)) {
      sendJson(res, 401, { error: 'invalid_code' });
      return;
    }
    db.authRequests.delete(requestId);
    let user = Array.from(db.users.values()).find(u => u.phoneHash === hashPhone(entry.phone));
    if (!user) {
      const userId = randomUUID();
      user = {
        id: userId,
        phoneHash: hashPhone(entry.phone),
        age: 18,
        gender: null,
        createdAt: new Date().toISOString(),
        status: 'active',
        isPro: false,
        proExpiresAt: null,
        kycStatus: 'pending'
      };
      db.users.set(userId, user);
      ensureUserProfile(userId);
    }
    const { accessToken, refreshToken } = issueTokens(user.id);
    sendJson(res, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      user_id: user.id
    });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('POST', '/v1/auth/refresh', async (req, res) => {
  try {
    const body = await readBody(req);
    const { refresh_token: refreshToken } = body;
    const rotated = rotateAccessToken(refreshToken);
    if (!rotated) {
      sendJson(res, 401, { error: 'invalid_refresh' });
      return;
    }
    sendJson(res, 200, { access_token: rotated.accessToken });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/me', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  ensureUserProfile(user.id);
  const profile = db.profiles.get(user.id);
  const reputation = db.reputations.get(user.id);
  const location = db.locations.get(user.id);
  sendJson(res, 200, {
    user,
    profile,
    reputation,
    location
  });
});

register('PUT', '/v1/me', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    ensureUserProfile(user.id);
    const profile = db.profiles.get(user.id);
    const allowed = ['nickname', 'bio', 'favoriteDrink', 'haveAtHome', 'bringWithYou', 'talkTopics', 'moodTags'];
    allowed.forEach(field => {
      if (body[field] !== undefined) {
        profile[field] = body[field];
      }
    });
    if (body.age) {
      user.age = body.age;
    }
    if (body.gender) {
      user.gender = body.gender;
    }
    if (body.kycStatus) {
      user.kycStatus = body.kycStatus;
    }
    sendJson(res, 200, { profile });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('PUT', '/v1/me/photos', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    ensureUserProfile(user.id);
    const profile = db.profiles.get(user.id);
    if (!Array.isArray(body.photos)) {
      sendJson(res, 400, { error: 'photos_array_required' });
      return;
    }
    profile.photos = body.photos.slice(0, 5);
    sendJson(res, 200, { photos: profile.photos });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('PUT', '/v1/me/location', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    ensureUserProfile(user.id);
    const location = db.locations.get(user.id);
    if (typeof body.lat === 'number') location.lat = body.lat;
    if (typeof body.lon === 'number') location.lon = body.lon;
    if (typeof body.visibilityMode === 'string') location.visibilityMode = body.visibilityMode;
    if (typeof body.searchRadiusM === 'number') location.searchRadiusM = body.searchRadiusM;
    location.lastSeenAt = new Date().toISOString();
    sendJson(res, 200, { location });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/users/:id', async (req, res, params) => {
  const profile = toPublicProfile(params.id);
  if (!profile) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  sendJson(res, 200, profile);
});

register('GET', '/v1/feed', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  ensureUserProfile(user.id);
  const userLocation = db.locations.get(user.id);
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const page = Number(urlObj.searchParams.get('page') || '1');
  const pageSize = Number(urlObj.searchParams.get('page_size') || '20');
  const filters = {
    age: urlObj.searchParams.get('age'),
    drink: urlObj.searchParams.get('drink'),
    evening: urlObj.searchParams.get('evening_style'),
    topics: urlObj.searchParams.getAll('topics')
  };
  const seen = new Set(db.swipes.filter(s => s.swiperId === user.id).map(s => s.targetId));
  const cards = [];
  db.users.forEach(candidate => {
    if (candidate.id === user.id || candidate.status !== 'active') {
      return;
    }
    if (seen.has(candidate.id)) {
      return;
    }
    const candidateLocation = db.locations.get(candidate.id);
    if (!candidateLocation || candidateLocation.visibilityMode === 'hidden') {
      return;
    }
    const distance = computeDistanceMeters(userLocation, candidateLocation);
    if (filters.age) {
      const [minAge, maxAge] = filters.age.split('-').map(Number);
      if (candidate.age < minAge || (maxAge && candidate.age > maxAge)) {
        return;
      }
    }
    if (filters.drink) {
      const profile = db.profiles.get(candidate.id);
      if (!profile || profile.favoriteDrink !== filters.drink) {
        return;
      }
    }
    if (filters.evening) {
      const profile = db.profiles.get(candidate.id);
      if (!profile || !profile.moodTags.includes(filters.evening)) {
        return;
      }
    }
    if (filters.topics.length > 0) {
      const profile = db.profiles.get(candidate.id);
      if (!profile) {
        return;
      }
      const overlap = profile.talkTopics.filter(topic => filters.topics.includes(topic));
      if (overlap.length === 0) {
        return;
      }
    }
    const profile = db.profiles.get(candidate.id);
    const reputation = db.reputations.get(candidate.id) || { score: 0, badges: [] };
    cards.push({
      user_id: candidate.id,
      nickname: profile.nickname,
      distance_m: distance,
      favorite_drink: profile.favoriteDrink,
      tags: profile.talkTopics.slice(0, 3),
      preview_photos: profile.photos.slice(0, 1),
      reputation
    });
  });
  cards.sort((a, b) => a.distance_m - b.distance_m || (b.reputation.score - a.reputation.score));
  const { items, nextPage } = paginate(cards, page, pageSize);
  sendJson(res, 200, {
    items,
    next_page: nextPage
  });
});

register('POST', '/v1/swipes', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    const { target_id: targetId, direction } = body;
    if (!targetId || !['like', 'pass'].includes(direction)) {
      sendJson(res, 400, { error: 'invalid_payload' });
      return;
    }
    db.swipes.push({
      id: randomUUID(),
      swiperId: user.id,
      targetId,
      direction,
      createdAt: new Date().toISOString()
    });
    let match = null;
    if (direction === 'like') {
      const reciprocal = db.swipes.find(s => s.swiperId === targetId && s.targetId === user.id && s.direction === 'like');
      if (reciprocal) {
        const matchId = randomUUID();
        match = {
          id: matchId,
          userA: user.id,
          userB: targetId,
          createdAt: new Date().toISOString(),
          isActive: true
        };
        db.matches.set(matchId, match);
      }
    }
    sendJson(res, 200, {
      status: 'recorded',
      match
    });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/matches', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  const items = Array.from(db.matches.values()).filter(match => (match.userA === user.id || match.userB === user.id)).map(match => ({
    id: match.id,
    other_user: match.userA === user.id ? toPublicProfile(match.userB) : toPublicProfile(match.userA),
    created_at: match.createdAt,
    is_active: match.isActive
  }));
  sendJson(res, 200, { items });
});

register('POST', '/v1/matches/:id/close', async (req, res, params) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  const match = db.matches.get(params.id);
  if (!match || (match.userA !== user.id && match.userB !== user.id)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  match.isActive = false;
  sendJson(res, 200, { status: 'closed' });
});

register('GET', '/v1/matches/:id/messages', async (req, res, params) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  const match = db.matches.get(params.id);
  if (!match || (match.userA !== user.id && match.userB !== user.id)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const limit = Number(urlObj.searchParams.get('limit') || '50');
  const messages = db.messages.get(match.id) || [];
  sendJson(res, 200, { items: messages.slice(-limit) });
});

register('POST', '/v1/matches/:id/messages', async (req, res, params) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  const match = db.matches.get(params.id);
  if (!match || !match.isActive || (match.userA !== user.id && match.userB !== user.id)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  try {
    const body = await readBody(req);
    if (!body.text && !body.attachment) {
      sendJson(res, 400, { error: 'empty_message' });
      return;
    }
    const message = {
      id: randomUUID(),
      matchId: match.id,
      senderId: user.id,
      text: body.text || null,
      attachment: body.attachment || null,
      createdAt: new Date().toISOString()
    };
    const list = db.messages.get(match.id) || [];
    list.push(message);
    db.messages.set(match.id, list);
    sendJson(res, 200, { message });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('POST', '/v1/reviews', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    if (!body.reviewee_id || !body.scales) {
      sendJson(res, 400, { error: 'invalid_payload' });
      return;
    }
    const review = {
      id: randomUUID(),
      reviewerId: user.id,
      revieweeId: body.reviewee_id,
      meetingAt: body.meeting_at || new Date().toISOString(),
      scales: body.scales,
      flags: body.flags || {},
      comment: body.comment || '',
      createdAt: new Date().toISOString(),
      status: 'approved'
    };
    db.reviews.push(review);
    summariseReputation(body.reviewee_id);
    sendJson(res, 200, { review });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/reviews/:userId', async (req, res, params) => {
  const userReviews = db.reviews.filter(r => r.revieweeId === params.userId).slice(-5);
  sendJson(res, 200, { items: userReviews });
});

register('GET', '/v1/reputation/:userId', async (req, res, params) => {
  const reputation = db.reputations.get(params.userId);
  if (!reputation) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  sendJson(res, 200, {
    score: Number(reputation.score.toFixed(2)),
    badges: reputation.badges,
    averages: {
      warmth: Number(reputation.avgWarmth.toFixed(2)),
      sanity: Number(reputation.avgSanity.toFixed(2)),
      stamina: Number(reputation.avgStamina.toFixed(2))
    }
  });
});

register('GET', '/v1/places/nearby', async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const lat = Number(urlObj.searchParams.get('lat'));
  const lon = Number(urlObj.searchParams.get('lon'));
  const radius = Number(urlObj.searchParams.get('radius') || '5000');
  const type = urlObj.searchParams.get('type');
  const now = Date.now();
  const items = [];
  db.places.forEach(place => {
    if (place.status !== 'active') {
      return;
    }
    if (place.type === 'ready_now' && now - new Date(place.createdAt).getTime() > 2 * 60 * 60 * 1000) {
      return;
    }
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      const distance = computeDistanceMeters({ lat, lon }, { lat: place.lat, lon: place.lon });
      if (distance > radius) {
        return;
      }
    }
    if (type && place.type !== type) {
      return;
    }
    items.push({
      id: place.id,
      type: place.type,
      title: place.title,
      desc: place.desc,
      lat: Number(place.lat.toFixed(3)),
      lon: Number(place.lon.toFixed(3)),
      media: place.media,
      creator_id: place.creatorId
    });
  });
  sendJson(res, 200, { items });
});

register('POST', '/v1/places', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    if (!body.type || !body.title) {
      sendJson(res, 400, { error: 'invalid_payload' });
      return;
    }
    const place = {
      id: randomUUID(),
      creatorId: user.id,
      type: body.type,
      title: body.title,
      desc: body.desc || '',
      lat: body.lat || db.locations.get(user.id)?.lat || 0,
      lon: body.lon || db.locations.get(user.id)?.lon || 0,
      media: body.media || [],
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    db.places.set(place.id, place);
    sendJson(res, 201, { place });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('PUT', '/v1/places/:id/status', async (req, res, params) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const place = db.places.get(params.id);
    if (!place || (place.creatorId !== user.id && !requireAdmin(req))) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const body = await readBody(req);
    if (!['active', 'hidden', 'blocked'].includes(body.status)) {
      sendJson(res, 400, { error: 'invalid_status' });
      return;
    }
    place.status = body.status;
    sendJson(res, 200, { place });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/billing/products', async (_req, res) => {
  sendJson(res, 200, { items: products });
});

register('POST', '/v1/billing/purchase', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    const product = products.find(p => p.id === body.product_id);
    if (!product) {
      sendJson(res, 400, { error: 'unknown_product' });
      return;
    }
    const payment = {
      id: randomUUID(),
      userId: user.id,
      provider: body.provider || 'sandbox',
      productId: product.id,
      amount: product.price,
      currency: product.currency,
      status: 'confirmed',
      startedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString()
    };
    db.payments.push(payment);
    user.isPro = true;
    const expiresAt = new Date(Date.now() + product.durationDays * 24 * 60 * 60 * 1000);
    user.proExpiresAt = expiresAt.toISOString();
    sendJson(res, 200, { payment, pro_expires_at: user.proExpiresAt });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/billing/status', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  const now = Date.now();
  const isPro = Boolean(user.proExpiresAt && new Date(user.proExpiresAt).getTime() > now);
  sendJson(res, 200, {
    is_pro: isPro,
    expires_at: user.proExpiresAt
  });
});

register('POST', '/v1/report', async (req, res) => {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    if (!body.target_type || !body.target_id) {
      sendJson(res, 400, { error: 'invalid_payload' });
      return;
    }
    const report = {
      id: randomUUID(),
      reporterId: user.id,
      targetType: body.target_type,
      targetId: body.target_id,
      reason: body.reason || '',
      createdAt: new Date().toISOString(),
      status: 'pending'
    };
    db.abuseReports.push(report);
    sendJson(res, 201, { report });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/v1/admin/moderation/queue', async (req, res) => {
  if (!requireAdmin(req)) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  const queue = buildModerationQueue();
  sendJson(res, 200, { items: queue });
});

register('POST', '/v1/admin/moderation/resolve', async (req, res) => {
  if (!requireAdmin(req)) {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }
  try {
    const body = await readBody(req);
    const { target_type: type, target_id: id, decision } = body;
    if (!['approve', 'reject', 'ban'].includes(decision)) {
      sendJson(res, 400, { error: 'invalid_decision' });
      return;
    }
    if (type === 'user') {
      const user = db.users.get(id);
      if (user) {
        user.status = decision === 'ban' ? 'banned' : 'active';
      }
    } else if (type === 'place') {
      const place = db.places.get(id);
      if (place) {
        place.status = decision === 'approve' ? 'active' : 'blocked';
      }
    } else if (type === 'review') {
      const review = db.reviews.find(r => r.id === id);
      if (review) {
        review.status = decision === 'approve' ? 'approved' : 'rejected';
      }
    }
    db.auditLogs.push({
      id: randomUUID(),
      actorType: 'admin',
      actorId: 'admin',
      action: 'moderation_resolve',
      payload: { type, id, decision },
      createdAt: new Date().toISOString()
    });
    sendJson(res, 200, { status: 'ok' });
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_json', details: err.message });
  }
});

register('GET', '/healthz', async (_req, res) => {
  sendJson(res, 200, { status: 'ok', now: new Date().toISOString() });
});

seed();

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    const handler = routes.find(route => route.method === 'OPTIONS');
    if (handler) {
      handler.handler(req, res);
      return;
    }
  }
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  for (const route of routes) {
    if (route.method !== req.method) {
      continue;
    }
    if (route.pattern === '*') {
      continue;
    }
    const { matched, params } = matchRoute(route.pattern, urlObj.pathname);
    if (matched) {
      try {
        await route.handler(req, res, params);
      } catch (err) {
        console.error('Unhandled error', err);
        sendJson(res, 500, { error: 'internal_error', details: err.message });
      }
      return;
    }
  }
  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Sobutylniki API listening on port ${PORT}`);
});
