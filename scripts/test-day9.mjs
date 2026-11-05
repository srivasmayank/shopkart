import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaClient, OrderStatus } from '@prisma/client';

const prisma = new PrismaClient();
const agent = new http.Agent({ keepAlive: false, maxSockets: 100 });
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_webhook_secret_shopkart2026';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    let data = null;
    const reqHeaders = { ...headers };
    if (body !== null) {
      data = typeof body === 'string' ? body : JSON.stringify(body);
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
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

function signWebhook(payloadStr, secret = WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(payloadStr).digest('hex');
}

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
  console.log('🧪 Starting Day 9: Webhook Security & Order State Machine Test Suite...\n');

  let serverProcess = null;
  const isUp = await waitForServer(2);
  if (!isUp) {
    console.log('Spawning ShopKart API server (node dist/main.js)...');
    serverProcess = spawn('node', ['dist/main.js'], {
      stdio: 'ignore',
      env: { ...process.env, PORT: '3000', RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET },
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
    console.log('--- Phase 1: Authentication & Seed Setup ---');
    const adminLogin = await post('/auth/login', { email: 'asha@test.com', password: 'secret123' });
    const adminToken = adminLogin.body?.accessToken;
    assert(adminLogin.status === 201 && adminToken, 'Admin logged in');

    const customerLogin = await post('/auth/login', { email: 'ravi@test.com', password: 'secret123' });
    const customerToken = customerLogin.body?.accessToken;
    assert(customerLogin.status === 201 && customerToken, 'Customer logged in');

    // 2. Webhook Security & HMAC Verification
    console.log('\n--- Phase 2: Webhook Security & HMAC-SHA256 Timing-Safe Verification ---');
    const dummyPayload = JSON.stringify({ event: 'order.paid', payload: {} });

    // 2a. Missing signature header
    const noSigRes = await post('/payments/webhook', dummyPayload, {});
    assert(noSigRes.status === 400, 'Webhook missing x-razorpay-signature rejected with HTTP 400');

    // 2b. Forged / invalid signature
    const invalidSigRes = await post('/payments/webhook', dummyPayload, {
      'x-razorpay-signature': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    assert(invalidSigRes.status === 401, 'Webhook with forged HMAC signature rejected with HTTP 401 Unauthorized');

    // 2c. Tampered payload with otherwise valid signature
    const legitPayload = JSON.stringify({ event: 'ping', test: 'authentic' });
    const legitSignature = signWebhook(legitPayload);
    const tamperedPayload = JSON.stringify({ event: 'ping', test: 'tampered' });
    const tamperedRes = await post('/payments/webhook', tamperedPayload, {
      'x-razorpay-signature': legitSignature,
    });
    assert(tamperedRes.status === 401, 'Tampered webhook payload rejected with HTTP 401 Unauthorized');

    // 2d. Correct HMAC signature
    const validRes = await post('/payments/webhook', legitPayload, {
      'x-razorpay-signature': legitSignature,
    });
    assert(validRes.status === 200 && validRes.body?.received === true, 'Authentic HMAC signature accepted with HTTP 200 OK');

    // 3. Order State Machine: PAYMENT_PENDING -> PAID
    console.log('\n--- Phase 3: State Machine: PAYMENT_PENDING -> PAID (Webhook order.paid) ---');
    const prodRes1 = await post(
      '/products',
      { name: `SM Test Shoe #${Date.now()}`, pricePaise: 350000, stock: 10 },
      { Authorization: `Bearer ${adminToken}` },
    );
    const product1Id = prodRes1.body?.id;

    // Place Order 1 (quantity 2 -> stock becomes 8)
    const order1Res = await post(
      '/orders',
      { items: [{ productId: product1Id, quantity: 2 }] },
      { Authorization: `Bearer ${customerToken}`, 'Idempotency-Key': `sm-order1-${randomUUID()}` },
    );
    const order1Id = order1Res.body?.id;
    assert(order1Res.status === 201 && order1Res.body?.status === 'PAYMENT_PENDING', `Order #${order1Id} created with status PAYMENT_PENDING`);

    // Initiate payment
    const pay1Res = await post(`/orders/${order1Id}/pay`, {}, { Authorization: `Bearer ${customerToken}` });
    const rzpOrder1Id = pay1Res.body?.razorpayOrderId;
    assert(pay1Res.status === 201 && rzpOrder1Id, `Order #${order1Id} generated Razorpay Order ID: "${rzpOrder1Id}"`);

    // Send signed order.paid webhook
    const payment1Id = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const paidWebhookPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder1Id, amount: 700000, status: 'paid' } },
        payment: { entity: { id: payment1Id, order_id: rzpOrder1Id, amount: 700000, status: 'captured' } },
      },
    });

    const paidWebhookRes = await post('/payments/webhook', paidWebhookPayload, {
      'x-razorpay-signature': signWebhook(paidWebhookPayload),
    });
    assert(
      paidWebhookRes.status === 200 && paidWebhookRes.body?.action === 'TRANSITIONED' && paidWebhookRes.body?.status === 'PAID',
      `Webhook order.paid transitioned Order #${order1Id} to status PAID`,
    );

    // Verify DB state
    const dbOrder1 = await prisma.order.findUnique({ where: { id: order1Id } });
    assert(
      dbOrder1?.status === OrderStatus.PAID && dbOrder1?.razorpayPaymentId === payment1Id,
      `Database verified: Order #${order1Id} is PAID with paymentId="${payment1Id}"`,
    );

    // Idempotency: Replay identical order.paid webhook
    const replayPaidRes = await post('/payments/webhook', paidWebhookPayload, {
      'x-razorpay-signature': signWebhook(paidWebhookPayload),
    });
    assert(
      replayPaidRes.status === 200 && replayPaidRes.body?.action === 'ALREADY_PAID',
      `Duplicate order.paid webhook acknowledged idempotently with HTTP 200 (action: ALREADY_PAID)`,
    );

    // Illegal Transition: Try to cancel a PAID order via payment.failed webhook
    const failOnPaidPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      payload: {
        payment: { entity: { id: 'pay_fail_invalid', order_id: rzpOrder1Id, error_description: 'Card declined' } },
      },
    });
    const failOnPaidRes = await post('/payments/webhook', failOnPaidPayload, {
      'x-razorpay-signature': signWebhook(failOnPaidPayload),
    });
    assert(
      failOnPaidRes.status === 409,
      `State Guard: payment.failed on PAID order rejected with HTTP 409 Conflict (cannot cancel paid order)`,
    );

    // 4. Order State Machine: PAYMENT_PENDING -> CANCELLED & Inventory Restoration
    console.log('\n--- Phase 4: State Machine: PAYMENT_PENDING -> CANCELLED & Inventory Restoration ---');
    const prodRes2 = await post(
      '/products',
      { name: `SM Backpack #${Date.now()}`, pricePaise: 180000, stock: 15 },
      { Authorization: `Bearer ${adminToken}` },
    );
    const product2Id = prodRes2.body?.id;

    // Place Order 2 (quantity 5 -> stock becomes 15 - 5 = 10)
    const order2Res = await post(
      '/orders',
      { items: [{ productId: product2Id, quantity: 5 }] },
      { Authorization: `Bearer ${customerToken}`, 'Idempotency-Key': `sm-order2-${randomUUID()}` },
    );
    const order2Id = order2Res.body?.id;

    const stockAfterCheckout = await prisma.product.findUnique({ where: { id: product2Id } });
    assert(stockAfterCheckout?.stock === 10, `Initial stock reduced from 15 to 10 upon checkout`);

    // Initiate payment
    const pay2Res = await post(`/orders/${order2Id}/pay`, {}, { Authorization: `Bearer ${customerToken}` });
    const rzpOrder2Id = pay2Res.body?.razorpayOrderId;

    // Send payment.failed webhook
    const failWebhookPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      payload: {
        payment: { entity: { id: 'pay_failed_123', order_id: rzpOrder2Id, error_description: 'Insufficient funds' } },
      },
    });
    const failWebhookRes = await post('/payments/webhook', failWebhookPayload, {
      'x-razorpay-signature': signWebhook(failWebhookPayload),
    });
    assert(
      failWebhookRes.status === 200 && failWebhookRes.body?.action === 'CANCELLED' && failWebhookRes.body?.status === 'CANCELLED',
      `Webhook payment.failed transitioned Order #${order2Id} to status CANCELLED`,
    );

    // Crucial check: Inventory Restoration
    const stockAfterCancel = await prisma.product.findUnique({ where: { id: product2Id } });
    assert(
      stockAfterCancel?.stock === 15,
      `ATOMIC INVENTORY RESTORATION: Product stock restored from 10 back to 15!`,
    );

    // Idempotency: Duplicate payment.failed webhook
    const replayFailRes = await post('/payments/webhook', failWebhookPayload, {
      'x-razorpay-signature': signWebhook(failWebhookPayload),
    });
    assert(
      replayFailRes.status === 200 && replayFailRes.body?.action === 'ALREADY_CANCELLED',
      `Duplicate payment.failed webhook acknowledged idempotently with HTTP 200 (action: ALREADY_CANCELLED)`,
    );

    const stockAfterReplay = await prisma.product.findUnique({ where: { id: product2Id } });
    assert(
      stockAfterReplay?.stock === 15,
      `Zero Double-Restoration: Duplicate cancellation did NOT increment stock a second time (stock remains 15)`,
    );

    // Illegal Transition: Late order.paid webhook arriving on CANCELLED order
    const latePaidPayload = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      payload: {
        order: { entity: { id: rzpOrder2Id, amount: 900000, status: 'paid' } },
        payment: { entity: { id: 'pay_late_123', order_id: rzpOrder2Id, amount: 900000, status: 'captured' } },
      },
    });
    const latePaidRes = await post('/payments/webhook', latePaidPayload, {
      'x-razorpay-signature': signWebhook(latePaidPayload),
    });
    assert(
      latePaidRes.status === 409,
      `State Guard: Late order.paid webhook on CANCELLED order rejected with HTTP 409 Conflict`,
    );

    // 5. Customer-Initiated Cancellation (POST /orders/:id/cancel)
    console.log('\n--- Phase 5: Customer-Initiated Cancellation & IDOR Defense ---');
    // Place Order 3 (quantity 3 -> stock becomes 15 - 3 = 12)
    const order3Res = await post(
      '/orders',
      { items: [{ productId: product2Id, quantity: 3 }] },
      { Authorization: `Bearer ${customerToken}`, 'Idempotency-Key': `sm-order3-${randomUUID()}` },
    );
    const order3Id = order3Res.body?.id;
    const stockBeforeUserCancel = await prisma.product.findUnique({ where: { id: product2Id } });
    assert(stockBeforeUserCancel?.stock === 12, `Stock deducted to 12 for Order #${order3Id}`);

    // IDOR Protection: Admin/Attacker tries to cancel customer's order
    const idorCancel = await post(`/orders/${order3Id}/cancel`, {}, { Authorization: `Bearer ${adminToken}` });
    assert(
      idorCancel.status === 404,
      `IDOR Defended: Unauthorized caller cancelling another user's order receives silent HTTP 404 Not Found`,
    );

    // Legitimate customer cancels their pending order
    const customerCancelRes = await post(`/orders/${order3Id}/cancel`, {}, { Authorization: `Bearer ${customerToken}` });
    assert(
      customerCancelRes.status === 201 && customerCancelRes.body?.status === 'CANCELLED',
      `Customer successfully cancelled Order #${order3Id} (status: CANCELLED)`,
    );

    const stockAfterUserCancel = await prisma.product.findUnique({ where: { id: product2Id } });
    assert(
      stockAfterUserCancel?.stock === 15,
      `Product stock restored from 12 back to 15 after customer cancellation!`,
    );

    // Customer tries to cancel a PAID order (Order 1)
    const cancelPaidRes = await post(`/orders/${order1Id}/cancel`, {}, { Authorization: `Bearer ${customerToken}` });
    assert(
      cancelPaidRes.status === 409,
      `State Guard: Customer attempting to cancel PAID order #${order1Id} rejected with HTTP 409 Conflict`,
    );

    // Summary
    console.log(`\n========================================`);
    console.log(`Day 9 Test Results: ${passed} Passed, ${failed} Failed`);
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
