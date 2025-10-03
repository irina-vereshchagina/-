const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const PORT = 3101;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = 'admin-secret';

let serverProcess;

async function startServer() {
  const child = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const ready = new Promise((resolve, reject) => {
    const onData = data => {
      const text = data.toString();
      if (text.includes('Sobutylniki API listening')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.once('error', reject);
    child.stdout.on('data', onData);
    child.stderr.on('data', data => {
      const text = data.toString();
      if (text.includes('EADDRINUSE')) {
        reject(new Error('Port already in use'));
      }
    });
  });

  await ready;
  return child;
}

async function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  await once(serverProcess, 'exit');
}

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (token) {
    init.headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Failed to parse JSON for ${method} ${path}: ${text}`);
  }
  if (!response.ok) {
    const error = data && data.error ? data.error : response.statusText;
    throw new Error(`Request failed: ${method} ${path} -> ${response.status} ${error}`);
  }
  return data;
}

async function register(phone) {
  const { request_id, mock_code } = await request('/v1/auth/request_code', {
    method: 'POST',
    body: { phone }
  });
  const { access_token: accessToken, refresh_token: refreshToken, user_id: userId } = await request('/v1/auth/verify_code', {
    method: 'POST',
    body: { request_id, code: mock_code }
  });
  const me = await request('/v1/me', { token: accessToken });
  return { accessToken, refreshToken, userId, me };
}

async function adminRequest(path, { method = 'GET', body } = {}) {
  return request(path, {
    method,
    body,
    headers: { 'X-Admin-Key': ADMIN_KEY }
  });
}

before(async () => {
  serverProcess = await startServer();
});

after(async () => {
  await stopServer();
});

test('end-to-end social flow', async () => {
  const unique = Date.now();
  const userA = await register(`+7900${unique % 100000000}01`);
  const userB = await register(`+7900${unique % 100000000}02`);

  await request('/v1/me', {
    method: 'PUT',
    token: userA.accessToken,
    body: {
      nickname: 'Алиса',
      favoriteDrink: 'просекко',
      talkTopics: ['коты', 'кино', 'музыка'],
      moodTags: ['душевно на кухне']
    }
  });

  await request('/v1/me', {
    method: 'PUT',
    token: userB.accessToken,
    body: {
      nickname: 'Боб',
      favoriteDrink: 'вино',
      talkTopics: ['настолки', 'кино'],
      moodTags: ['настолки']
    }
  });

  await request('/v1/me/location', {
    method: 'PUT',
    token: userA.accessToken,
    body: { lat: 55.751, lon: 37.618, visibilityMode: 'visible', searchRadiusM: 5000 }
  });

  await request('/v1/me/location', {
    method: 'PUT',
    token: userB.accessToken,
    body: { lat: 55.752, lon: 37.619, visibilityMode: 'visible', searchRadiusM: 5000 }
  });

  const feed = await request('/v1/feed', { token: userA.accessToken });
  assert.ok(feed.items.some(card => card.user_id === userB.userId), 'User B should appear in User A feed');

  const swipeA = await request('/v1/swipes', {
    method: 'POST',
    token: userA.accessToken,
    body: { target_id: userB.userId, direction: 'like' }
  });
  assert.equal(swipeA.match, null, 'First like should not immediately produce a match');

  const swipeB = await request('/v1/swipes', {
    method: 'POST',
    token: userB.accessToken,
    body: { target_id: userA.userId, direction: 'like' }
  });
  assert.ok(swipeB.match && swipeB.match.id, 'Reciprocal like should create a match');
  const matchId = swipeB.match.id;

  const matches = await request('/v1/matches', { token: userA.accessToken });
  assert.ok(matches.items.some(match => match.id === matchId), 'Match should be visible to user A');

  await request(`/v1/matches/${matchId}/messages`, {
    method: 'POST',
    token: userA.accessToken,
    body: { text: 'Привет! Как настроение?' }
  });

  const messages = await request(`/v1/matches/${matchId}/messages?limit=5`, {
    token: userB.accessToken
  });
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0].text, 'Привет! Как настроение?');

  await request('/v1/reviews', {
    method: 'POST',
    token: userA.accessToken,
    body: {
      reviewee_id: userB.userId,
      scales: { warmth: 5, sanity: 4, stamina: 5 },
      flags: { belka: false },
      comment: 'Отлично посидели'
    }
  });

  const reputation = await request(`/v1/reputation/${userB.userId}`);
  assert.ok(reputation.score >= 4.5, 'Reputation score should reflect new review');
  assert.ok(Array.isArray(reputation.badges));

  const placeResp = await request('/v1/places', {
    method: 'POST',
    token: userA.accessToken,
    body: {
      type: 'ready_now',
      title: 'Уютная кухня',
      desc: 'Свежие закуски и настолки',
      lat: 55.751,
      lon: 37.618,
      media: ['https://example.com/photo.jpg']
    }
  });
  const placeId = placeResp.place.id;

  const queue = await adminRequest('/v1/admin/moderation/queue');
  assert.ok(queue.items.some(item => item.type === 'place' && item.id === placeId));

  await adminRequest('/v1/admin/moderation/resolve', {
    method: 'POST',
    body: { target_type: 'place', target_id: placeId, decision: 'approve' }
  });

  await request(`/v1/places/${placeId}/status`, {
    method: 'PUT',
    token: userA.accessToken,
    body: { status: 'hidden' }
  });

  await request(`/v1/places/${placeId}/status`, {
    method: 'PUT',
    token: userA.accessToken,
    body: { status: 'active' }
  });

  const nearby = await request('/v1/places/nearby?lat=55.751&lon=37.618&radius=500');
  assert.ok(nearby.items.some(place => place.id === placeId), 'Active place should appear in nearby search');

  const products = await request('/v1/billing/products');
  assert.ok(products.items.length > 0);

  await request('/v1/billing/purchase', {
    method: 'POST',
    token: userA.accessToken,
    body: { product_id: products.items[0].id, provider: 'sandbox' }
  });

  const billingStatus = await request('/v1/billing/status', { token: userA.accessToken });
  assert.equal(billingStatus.is_pro, true);

  const report = await request('/v1/report', {
    method: 'POST',
    token: userA.accessToken,
    body: { target_type: 'user', target_id: userB.userId, reason: 'spam' }
  });
  assert.equal(report.report.status, 'pending');
});
