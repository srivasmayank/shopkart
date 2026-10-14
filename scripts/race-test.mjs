import http from 'node:http';
import { randomUUID } from 'node:crypto';

const agent = new http.Agent({ keepAlive: false, maxSockets: 100 });

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      'http://localhost:3000' + path,
      {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
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
    req.write(data);
    req.end();
  });
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      'http://localhost:3000' + path,
      { method: 'GET', agent, headers },
      (res) => {
        let bodyStr = '';
        res.on('data', (c) => (bodyStr += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(bodyStr) });
          } catch {
            resolve({ status: res.statusCode, body: bodyStr });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function runRaceTest() {
  console.log('⚡ Concurrency Warfare: Point 1 of Day 5');
  console.log('🎯 Objective: Prove the check-then-act overselling race condition on POST /orders/naive\n');

  // Step 1: Login as admin
  const loginRes = await post('/auth/login', {
    email: 'asha@test.com',
    password: 'secret123',
  });
  const accessToken = loginRes.body.accessToken;

  // Step 2: Create a product with INITIAL STOCK: 1
  const createProdRes = await post(
    '/products',
    {
      name: `Flash Sale Shoe #${Date.now().toString().slice(-4)}`,
      pricePaise: 249900,
      stock: 1,
    },
    { Authorization: `Bearer ${accessToken}` },
  );
  const product = createProdRes.body;
  console.log(`📦 Created test product: "${product.name}" (ID: ${product.id}) with INITIAL STOCK: ${product.stock}`);

  // Step 3: Fire 50 simultaneous HTTP requests across 50 independent parallel sockets
  console.log(`🔥 Firing 50 parallel TCP socket checkouts at the exact same instant...`);

  const statuses = await Promise.all(
    Array.from({ length: 50 }, () =>
      post(
        '/orders/naive',
        { items: [{ productId: product.id, quantity: 1 }] },
        {
          Authorization: `Bearer ${accessToken}`,
          'Idempotency-Key': randomUUID(),
        },
      ).then((r) => r.status),
    ),
  );

  const created201 = statuses.filter((s) => s === 201).length;
  const soldOut409 = statuses.filter((s) => s === 409).length;

  const finalProduct = (await get(`/products/${product.id}`)).body;

  console.log('\n📊 Concurrency Race Results:');
  console.log(`   - 201 Created (Orders Approved): ${created201}`);
  console.log(`   - 409 Sold Out (Orders Rejected): ${soldOut409}`);
  console.log(`   - Remaining Stock in DB: ${finalProduct.stock}`);

  console.log('\n🚨 Architectural Analysis:');
  if (created201 > 1) {
    console.log(`   ⚠️ BUG OFFICIALLY PROVEN: OVERSELLING OCCURRED!`);
    console.log(`   ${created201} orders were successfully placed for a product with only 1 item in stock!`);
    console.log(`   Root Cause: Check-Then-Act flaw in naive checkout. Requests interleaved during the gap`);
    console.log(`   between reading stock and updating it, resulting in lost updates.`);
  } else {
    console.log(`   Requests completed: 201s: ${created201}, 409s: ${soldOut409}`);
  }
}

runRaceTest().catch(console.error);

