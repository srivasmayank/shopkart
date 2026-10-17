import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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

    prisma = app.get(PrismaService);

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
        .send({ items: [{ productId: 2, quantity: 1 }] })
        .expect(400);
    });

    it('should return identical response and avoid duplicate inventory decrement on retries', async () => {
      const initialProduct = await prisma.product.findUniqueOrThrow({ where: { id: 2 } });
      const key = `jest-idem-${randomUUID()}`;

      // First call
      const firstRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: 2, quantity: 1 }] })
        .expect(201);

      const orderId = firstRes.body.id;

      // Replay identical call
      const replayRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: 2, quantity: 1 }] });

      expect(replayRes.body.id).toBe(orderId);

      // Verify stock was decremented exactly once
      const finalProduct = await prisma.product.findUniqueOrThrow({ where: { id: 2 } });
      expect(finalProduct.stock).toBe(initialProduct.stock - 1);
    });
  });

  describe('IDOR Protection', () => {
    it('should return 404 when querying an order belonging to another user', async () => {
      // Create an order as customer
      const key = `jest-idor-${randomUUID()}`;
      const orderRes = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send({ items: [{ productId: 2, quantity: 1 }] })
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
});

