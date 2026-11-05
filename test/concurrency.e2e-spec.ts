import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID, createHmac } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('ShopKart Concurrency & Correctness (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let customerToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    const server = app.getHttpServer();
    if (server && typeof server.setMaxListeners === 'function') {
      server.setMaxListeners(100);
    }

    prisma = app.get(PrismaService);

    // Ensure test users exist with deterministic credentials
    const passwordHash = await bcrypt.hash('secret123', 10);
    await prisma.user.upsert({
      where: { email: 'asha@test.com' },
      update: { passwordHash, role: 'ADMIN' },
      create: { email: 'asha@test.com', passwordHash, role: 'ADMIN' },
    });
    await prisma.user.upsert({
      where: { email: 'ravi@test.com' },
      update: { passwordHash, role: 'CUSTOMER' },
      create: { email: 'ravi@test.com', passwordHash, role: 'CUSTOMER' },
    });

    // Login as admin
    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'asha@test.com', password: 'secret123' })
      .expect(201);
    adminToken = adminLogin.body.accessToken;

    // Login as customer
    const customerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ravi@test.com', password: 'secret123' })
      .expect(201);
    customerToken = customerLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Race Condition & Atomic Concurrency', () => {
    it('should allow exactly 1 purchase and reject 49 when 50 concurrent checkouts target 1 item', async () => {
      // 1. Create a product with stock = 1
      const createRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Jest Race Shoe #${Date.now().toString().slice(-4)}`,
          pricePaise: 249900,
          stock: 1,
        })
        .expect(201);

      const productId = createRes.body.id;

      // 2. Fire 50 simultaneous checkout requests
      const promises = Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/orders')
          .set('Authorization', `Bearer ${customerToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({ items: [{ productId, quantity: 1 }] }),
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map((r) => r.status);

      const created201 = statuses.filter((s) => s === 201).length;
      const soldOut409 = statuses.filter((s) => s === 409).length;

      expect(created201).toBe(1);
      expect(soldOut409).toBe(49);

      // 3. Verify stock in database is 0 (never negative)
      const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(p.stock).toBe(0);
    });
  });

  describe('Idempotency Keys', () => {
    it('should reject requests missing Idempotency-Key header', async () => {
      await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ items: [{ productId: 1, quantity: 1 }] })
        .expect(400);
    });

    it('should return identical response and avoid duplicate inventory decrement on retries', async () => {
      // Dynamically create a test product
      const prodRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Jest Idem Product #${Date.now()}`,
          pricePaise: 149900,
          stock: 10,
        })
        .expect(201);
      const testProductId = prodRes.body.id;
      const key = `jest-idem-${randomUUID()}`;

      // First call
      const firstRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: testProductId, quantity: 1 }] })
        .expect(201);

      const orderId = firstRes.body.id;

      // Replay identical call
      const replayRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: testProductId, quantity: 1 }] })
        .expect(201);

      expect(replayRes.body.id).toBe(orderId);

      // Verify stock was decremented exactly once (10 -> 9)
      const finalProduct = await prisma.product.findUniqueOrThrow({ where: { id: testProductId } });
      expect(finalProduct.stock).toBe(9);
    });
  });

  describe('IDOR Protection', () => {
    it('should return 404 when querying an order belonging to another user', async () => {
      // Dynamically create a product for this test
      const prodRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Jest IDOR Product #${Date.now()}`,
          pricePaise: 99900,
          stock: 5,
        })
        .expect(201);
      const testProductId = prodRes.body.id;

      // Create an order as customer
      const key = `jest-idor-${randomUUID()}`;
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: testProductId, quantity: 1 }] })
        .expect(201);

      const orderId = orderRes.body.id;

      // Admin (different user) attempts to access customer's order directly
      // Should return 404 Not Found to prevent confirming resource existence
      await request(app.getHttpServer())
        .get(`/orders/${orderId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('Day 9: Webhook Security & Order State Machine', () => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_webhook_secret_shopkart2026';

    function signPayload(payloadStr: string) {
      return createHmac('sha256', webhookSecret).update(payloadStr).digest('hex');
    }

    it('should reject webhook requests with invalid or tampered HMAC signatures', async () => {
      const payload = JSON.stringify({ event: 'ping', test: true });

      // Missing signature
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .send(payload)
        .set('Content-Type', 'application/json')
        .expect(400);

      // Forged signature
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .send(payload)
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
        .expect(401);
    });

    it('should transition order to PAID and guard against illegal cancellations', async () => {
      // 1. Create a product with stock = 10
      const prodRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Jest SM Shoe #${Date.now()}`,
          pricePaise: 299900,
          stock: 10,
        })
        .expect(201);
      const productId = prodRes.body.id;

      // 2. Checkout 2 units -> stock becomes 8, status = PAYMENT_PENDING
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', `jest-sm-paid-${randomUUID()}`)
        .send({ items: [{ productId, quantity: 2 }] })
        .expect(201);
      const orderId = orderRes.body.id;

      // 3. Initiate payment
      const payRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/pay`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(201);
      const rzpOrderId = payRes.body.razorpayOrderId;

      // 4. Send signed order.paid webhook
      const webhookPayload = JSON.stringify({
        event: 'order.paid',
        payload: {
          order: { entity: { id: rzpOrderId, amount: 599800, status: 'paid' } },
          payment: { entity: { id: 'pay_jest_123', order_id: rzpOrderId, amount: 599800, status: 'captured' } },
        },
      });

      const res = await request(app.getHttpServer())
        .post('/payments/webhook')
        .send(webhookPayload)
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signPayload(webhookPayload))
        .expect(200);

      expect(res.body.action).toBe('TRANSITIONED');
      expect(res.body.status).toBe('PAID');

      // 5. Verify database
      const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(dbOrder.status).toBe('PAID');
      expect(dbOrder.razorpayPaymentId).toBe('pay_jest_123');

      // 6. State guard: cannot cancel a PAID order
      const failPayload = JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: { entity: { id: 'pay_failed_456', order_id: rzpOrderId } },
        },
      });
      await request(app.getHttpServer())
        .post('/payments/webhook')
        .send(failPayload)
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', signPayload(failPayload))
        .expect(409);
    });

    it('should transition order to CANCELLED and restore inventory atomically', async () => {
      // 1. Create product with stock = 5
      const prodRes = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Jest SM Cancel Item #${Date.now()}`,
          pricePaise: 120000,
          stock: 5,
        })
        .expect(201);
      const productId = prodRes.body.id;

      // 2. Checkout 3 units -> stock becomes 2
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', `jest-sm-cancel-${randomUUID()}`)
        .send({ items: [{ productId, quantity: 3 }] })
        .expect(201);
      const orderId = orderRes.body.id;

      const pStockAfterOrder = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(pStockAfterOrder.stock).toBe(2);

      // 3. Customer calls cancel endpoint
      const cancelRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(201);

      expect(cancelRes.body.status).toBe('CANCELLED');

      // 4. Verify inventory restored atomically back to 5
      const pStockAfterCancel = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(pStockAfterCancel.stock).toBe(5);

      // 5. Idempotent cancel: cancelling again returns ALREADY_CANCELLED and does not increment stock to 8
      const cancelAgainRes = await request(app.getHttpServer())
        .post(`/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(201);
      expect(cancelAgainRes.body.status).toBe('ALREADY_CANCELLED');
      expect(cancelAgainRes.body.order.status).toBe('CANCELLED');

      const pStockAfterAgain = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(pStockAfterAgain.stock).toBe(5);
    });
  });
});

