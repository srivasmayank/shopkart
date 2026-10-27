import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient, OrderStatus } from '@prisma/client';

const prisma = new PrismaClient();
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
      { method, agent, headers: reqHeaders },
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

async function waitForServer(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      await request('GET', '/');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

async function runTestSuite() {
  console.log('🧪 Starting Day 8: Razorpay Integration in Test Mode Test Suite...\n');

  let serverProcess = null;
  const isUp = await waitForServer(2);
  if (!isUp) {
    console.log('Spawning ShopKart API server (node dist/main.js)...');
    serverProcess = spawn('node', ['dist/main.js'], {
      stdio: 'ignore',
      env: { ...process.env, PORT: '3000' },
    });
    const ready = await waitForServer(30);
    if (!ready) {
      console.error('❌ Server failed to start on http://localhost:3000');
      if (serverProcess) serverProcess.kill();
      process.exit(1);
    }
    console.log('✅ Server online on http://localhost:3000\n');
  }

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Authenticate users
    console.log('--- Step 1: Authentication Setup ---');
    const adminLogin = await post('/auth/login', { email: 'asha@test.com', password: 'secret123' });
    const adminToken = adminLogin.body?.accessToken;
    assert(adminLogin.status === 201 && adminToken, 'Admin logged in and received JWT token');

    const customerLogin = await post('/auth/login', { email: 'ravi@test.com', password: 'secret123' });
    const customerToken = customerLogin.body?.accessToken;
    assert(customerLogin.status === 201 && customerToken, 'Customer logged in and received JWT token');

    // 2. Auth guard verification
    console.log('\n--- Step 2: Security & Authentication Guard ---');
    const noAuthPay = await post('/orders/1/pay', {});
    assert(noAuthPay.status === 401, 'POST /orders/:id/pay strictly requires Bearer authentication (HTTP 401)');

    // 3. Create a test product
    console.log('\n--- Step 3: Product Setup ---');
    const newProduct = await post(
      '/products',
      {
        name: `Razorpay Test Item #${Date.now()}`,
        pricePaise: 499900, // ₹4,999.00
        stock: 10,
      },
      { Authorization: `Bearer ${adminToken}` },
    );
    const productId = newProduct.body?.id;
    assert(newProduct.status === 201 && productId, `Created test product with ₹4,999.00 integer paise pricing (ID: ${productId})`);

    // 4. Place an order as customer
    console.log('\n--- Step 4: Checkout Order Creation ---');
    const orderKey = `rzp-test-order-${randomUUID()}`;
    const orderRes = await post(
      '/orders',
      { items: [{ productId, quantity: 2 }] }, // 2 * 499900 = 999800 paise (₹9,998.00)
      {
        Authorization: `Bearer ${customerToken}`,
        'Idempotency-Key': orderKey,
      },
    );
    const orderId = orderRes.body?.id;
    assert(
      orderRes.status === 201 && orderRes.body?.totalPaise === 999800 && orderRes.body?.status === 'PAYMENT_PENDING',
      `Order placed in PAYMENT_PENDING state with exact total: 999800 paise (Order ID: ${orderId})`,
    );

    // 5. Initiate payment via POST /orders/:id/pay
    console.log('\n--- Step 5: Razorpay Payment Initiation ---');
    const payRes = await post(`/orders/${orderId}/pay`, {}, { Authorization: `Bearer ${customerToken}` });
    assert(payRes.status === 201, `POST /orders/${orderId}/pay responded with HTTP 201 Created`);
    assert(typeof payRes.body?.razorpayOrderId === 'string' && payRes.body.razorpayOrderId.startsWith('order_'), `Returned valid Razorpay order ID: "${payRes.body?.razorpayOrderId}"`);
    assert(payRes.body?.amountPaise === 999800, `Returned exact amount in integer paise: ${payRes.body?.amountPaise}`);
    assert(payRes.body?.currency === 'INR', `Currency returned as "INR"`);
    assert(Boolean(payRes.body?.keyId), `Returned public client Key ID for Razorpay Checkout.js`);

    const razorpayOrderId = payRes.body?.razorpayOrderId;

    // 6. DB persistence check
    console.log('\n--- Step 6: Database Persistence ---');
    const dbOrder = await prisma.order.findUnique({ where: { id: orderId } });
    assert(dbOrder?.razorpayOrderId === razorpayOrderId, `orders table successfully persisted razorpay_order_id="${razorpayOrderId}"`);

    // 7. Idempotency test: calling pay endpoint repeatedly
    console.log('\n--- Step 7: Payment Initiation Idempotency ---');
    const repeatPay = await post(`/orders/${orderId}/pay`, {}, { Authorization: `Bearer ${customerToken}` });
    assert(repeatPay.status === 201, `Re-calling POST /orders/${orderId}/pay returns HTTP 201`);
    assert(
      repeatPay.body?.razorpayOrderId === razorpayOrderId,
      `Idempotent: Returned the identical razorpayOrderId ("${repeatPay.body?.razorpayOrderId}") without creating duplicates`,
    );

    // 8. IDOR protection
    console.log('\n--- Step 8: IDOR Attack Defense ---');
    const attackerPay = await post(`/orders/${orderId}/pay`, {}, { Authorization: `Bearer ${adminToken}` });
    assert(
      attackerPay.status === 404,
      `IDOR Defended: Unauthorized user attempting to pay for another user's order receives 404 Not Found (status: ${attackerPay.status})`,
    );

    const nonExistentPay = await post('/orders/999999/pay', {}, { Authorization: `Bearer ${customerToken}` });
    assert(nonExistentPay.status === 404, `Querying non-existent order ID 999999 returns 404 Not Found`);

    // 9. State guard check: paying for an already CANCELLED or PAID order
    console.log('\n--- Step 9: Order State Guard ---');
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });
    const cancelledPay = await post(`/orders/${orderId}/pay`, {}, { Authorization: `Bearer ${customerToken}` });
    assert(
      cancelledPay.status === 400,
      `State Guard: Attempting to pay for a CANCELLED order is rejected with HTTP 400 Bad Request (${cancelledPay.body?.message})`,
    );

    // Summary
    console.log(`\n========================================`);
    console.log(`Day 8 Test Results: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================\n`);

    if (failed > 0) process.exit(1);
  } finally {
    await prisma.$disconnect();
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

runTestSuite().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});

