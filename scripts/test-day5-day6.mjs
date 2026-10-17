import http from 'node:http';
import { randomUUID } from 'node:crypto';

const agent = new http.Agent({ keepAlive: false, maxSockets: 100 });

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (data) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      'http://localhost:3000' + path,
      {
        method,
        agent,
        headers: reqHeaders,
      },
      (res) => {
        let bodyStr = '';
        res.on('data', (c) => (bodyStr += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            parsed = bodyStr;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const post = (path, body, headers = {}) => request('POST', path, body, headers);
const get = (path, headers = {}) => request('GET', path, null, headers);

async function runTestSuite() {
  console.log('🧪 Starting Day 5 (Atomic Updates) & Day 6 (Idempotency & IDOR) Test Suite...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // Step 1: Obtain tokens for Admin (User 1) and Customer (User 2)
  const adminLogin = await post('/auth/login', { email: 'asha@test.com', password: 'secret123' });
  const adminToken = adminLogin.body.accessToken;

  const customerLogin = await post('/auth/login', { email: 'ravi@test.com', password: 'secret123' });
  const customerToken = customerLogin.body.accessToken;

  // -------------------------------------------------------------
  // PART 1: DAY 5 - ATOMIC CONDITIONAL UPDATE & RACE TEST FIX
  // -------------------------------------------------------------
  console.log('--- Part 1: Day 5 Atomic Concurrency Warfare ---');

  const createProdRes = await post(
    '/products',
    {
      name: `Atomic Sneaker #${Date.now().toString().slice(-4)}`,
      pricePaise: 249900,
      stock: 1, // EXACTLY 1 item in stock
    },
    { Authorization: `Bearer ${adminToken}` },
  );
  const raceProduct = createProdRes.body;
  console.log(`  Created test item "${raceProduct.name}" (ID: ${raceProduct.id}) with initial stock: 1`);

  console.log('  Firing 50 concurrent checkout requests across 50 sockets to POST /orders (atomic)...');
  const raceStatuses = await Promise.all(
    Array.from({ length: 50 }, () =>
      post(
        '/orders',
        { items: [{ productId: raceProduct.id, quantity: 1 }] },
        {
          Authorization: `Bearer ${customerToken}`,
          'Idempotency-Key': randomUUID(),
        },
      ).then((r) => r.status),
    ),
  );

  const created201 = raceStatuses.filter((s) => s === 201).length;
  const soldOut409 = raceStatuses.filter((s) => s === 409).length;
  const finalProduct = (await get(`/products/${raceProduct.id}`)).body;

  assert(
    created201 === 1 && soldOut409 === 49,
    `Atomic Update Fix: Exactly 1 order created (201) and 49 sold out (409). (Observed: ${created201} created, ${soldOut409} rejected)`,
  );
  assert(finalProduct.stock === 0, `Database stock strictly decremented to 0 without going negative`);

  // -------------------------------------------------------------
  // PART 2: DAY 6 - IDEMPOTENCY KEYS (DEDUPLICATION & RETRIES)
  // -------------------------------------------------------------
  console.log('\n--- Part 2: Day 6 Idempotency Keys ---');

  // Test 2.1: Missing Idempotency-Key header is rejected
  const missingKeyRes = await post(
    '/orders',
    { items: [{ productId: 2, quantity: 1 }] },
    { Authorization: `Bearer ${customerToken}` },
  );
  assert(missingKeyRes.status === 400, 'POST /orders without Idempotency-Key returns 400 Bad Request');

  // Test 2.2: First checkout with unique key succeeds
  const testKey = `checkout-${randomUUID()}`;
  const initialStockP3 = (await get('/products/3')).body.stock;

  const firstCheckout = await post(
    '/orders',
    { items: [{ productId: 3, quantity: 1 }] },
    {
      Authorization: `Bearer ${customerToken}`,
      'Idempotency-Key': testKey,
    },
  );
  assert(firstCheckout.status === 201, 'First checkout with key succeeds (201 Created)');
  const orderId = firstCheckout.body.id;

  // Test 2.3: Replaying the exact same request with same key
  const replayCheckout = await post(
    '/orders',
    { items: [{ productId: 3, quantity: 1 }] },
    {
      Authorization: `Bearer ${customerToken}`,
      'Idempotency-Key': testKey,
    },
  );
  const afterStockP3 = (await get('/products/3')).body.stock;

  assert(
    replayCheckout.body.id === orderId,
    `Idempotency Replay: Returns identical order ID (#${orderId}) without re-charging or double ordering`,
  );
  assert(
    afterStockP3 === initialStockP3 - 1,
    `Stock only decremented once: initial (${initialStockP3}) -> final (${afterStockP3})`,
  );

  // Test 2.4: Cross-user key theft protection
  const keyTheftRes = await post(
    '/orders',
    { items: [{ productId: 3, quantity: 1 }] },
    {
      Authorization: `Bearer ${adminToken}`, // Admin trying to reuse Customer's key
      'Idempotency-Key': testKey,
    },
  );
  assert(keyTheftRes.status === 409, 'Reusing another user’s Idempotency-Key returns 409 Conflict');

  // -------------------------------------------------------------
  // PART 3: DAY 6 - IDOR (INSECURE DIRECT OBJECT REFERENCE)
  // -------------------------------------------------------------
  console.log('\n--- Part 3: Day 6 IDOR Access Control ---');

  // Test 3.1: Ravi (Customer) views his own order
  const ownOrderRes = await get(`/orders/${orderId}`, {
    Authorization: `Bearer ${customerToken}`,
  });
  assert(ownOrderRes.status === 200 && ownOrderRes.body.id === orderId, 'Customer accesses own order (200 OK)');

  // Test 3.2: Asha (Admin) attempts to access Ravi's order URL directly
  // Scoped findMine returns 404 (not 403) so unauthorized users cannot enumerate existing order IDs
  const idorRes = await get(`/orders/${orderId}`, {
    Authorization: `Bearer ${adminToken}`,
  });
  assert(idorRes.status === 404, 'Accessing another user’s order returns 404 Not Found (IDOR prevented, avoids confirmation)');

  console.log(`\n🏁 All Day 5 & Day 6 Tests Completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

