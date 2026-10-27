import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { CreateOrderDto } from './orders.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Chapter 4.8: The Fix - Atomic conditional updates inside a transaction.
   * 1. Sort items by productId to acquire locks in a consistent order -> PREVENTS DEADLOCKS.
   * 2. Runs an atomic conditional update: UPDATE products SET stock = stock - qty WHERE id = :id AND stock >= qty
   *    If count === 0, the product is sold out and transaction rolls back cleanly.
   */
  private async createOrderInTx(
    tx: Prisma.TransactionClient,
    userId: number,
    dto: CreateOrderDto,
  ) {
    const items = [...dto.items].sort((a, b) => a.productId - b.productId);
    let total = 0;
    const lines: { productId: number; quantity: number; pricePaise: number }[] = [];

    for (const it of items) {
      const res = await tx.product.updateMany({
        where: { id: it.productId, stock: { gte: it.quantity } },
        data: { stock: { decrement: it.quantity } },
      });

      if (res.count === 0) {
        throw new ConflictException(`Product ${it.productId} is out of stock`);
      }

      const p = await tx.product.findUniqueOrThrow({ where: { id: it.productId } });
      total += p.pricePaise * it.quantity;
      lines.push({
        productId: p.id,
        quantity: it.quantity,
        pricePaise: p.pricePaise,
      });
    }

    return tx.order.create({
      data: {
        userId,
        totalPaise: total,
        items: { create: lines },
      },
      include: { items: true },
    });
  }

  /**
   * Chapter 4.9: Idempotent order creation using client-supplied keys.
   * Guarantees safe retries on unreliable networks (e.g. 4G double tap).
   */
  async placeOrder(userId: number, key: string, dto: CreateOrderDto) {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (existing) {
      if (existing.userId !== userId) {
        throw new ConflictException('Key belongs to another user');
      }
      return existing.response; // replay original answer
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Claim the key FIRST: a concurrent twin blocks here, then fails with "duplicate key"
        await tx.idempotencyKey.create({ data: { key, userId } });

        const order = await this.createOrderInTx(tx, userId, dto);
        const response = JSON.parse(JSON.stringify(order)); // plain JSON (dates -> strings)

        await tx.idempotencyKey.update({
          where: { key },
          data: { response },
        });

        return response;
      });
    } catch (e: any) {
      if (e.code === 'P2002') {
        // The concurrent twin won the race: replay its stored response
        const twin = await this.prisma.idempotencyKey.findUnique({ where: { key } });
        return twin?.response;
      }
      throw e;
    }
  }

  /**
   * Chapter 4.7: Naive implementation preserved for race condition demonstration.
   */
  async placeOrderNaive(userId: number, dto: CreateOrderDto) {
    const lines: { productId: number; quantity: number; pricePaise: number }[] = [];
    let total = 0;

    for (const it of dto.items) {
      const p = await this.prisma.product.findUniqueOrThrow({
        where: { id: it.productId },
      });

      if (p.stock < it.quantity) {
        throw new ConflictException(`Product ${p.id} out of stock`);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      await this.prisma.product.update({
        where: { id: p.id },
        data: { stock: p.stock - it.quantity },
      });

      total += p.pricePaise * it.quantity;
      lines.push({
        productId: p.id,
        quantity: it.quantity,
        pricePaise: p.pricePaise,
      });
    }

    return this.prisma.order.create({
      data: {
        userId,
        totalPaise: total,
        items: { create: lines },
      },
      include: { items: true },
    });
  }

  /**
   * Chapter 4.10: IDOR prevention - Scoped strictly to authenticated userId.
   * Returns 404 rather than 403 to avoid confirming resource existence.
   */
  async findMine(userId: number, id: number) {
    const order = await this.prisma.order.findFirst({
      where: { id, userId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async listMine(userId: number) {
    return this.prisma.order.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Chapter 5.2: Initiates payment for an order with Razorpay.
   * 1. IDOR prevention: verifies order belongs to caller (findMine).
   * 2. Checks order state is PAYMENT_PENDING.
   * 3. Idempotent: returns existing razorpayOrderId if already created.
   * 4. Persists razorpayOrderId in atomic record update.
   */
  async createPaymentOrder(userId: number, orderId: number) {
    const order = await this.findMine(userId, orderId);

    if (order.status !== OrderStatus.PAYMENT_PENDING) {
      throw new BadRequestException(
        `Order ${orderId} cannot be paid because it is already ${order.status}`,
      );
    }

    // Idempotent return if already generated
    if (order.razorpayOrderId) {
      return {
        orderId: order.id,
        razorpayOrderId: order.razorpayOrderId,
        amountPaise: order.totalPaise,
        currency: 'INR',
        keyId: this.payments.getPublicKey(),
      };
    }

    const rzpOrder = await this.payments.createRazorpayOrder(
      order.totalPaise,
      `order_rcpt_${order.id}`,
      {
        orderId: String(order.id),
        userId: String(userId),
      },
    );

    await this.prisma.order.update({
      where: { id: order.id },
      data: { razorpayOrderId: rzpOrder.id },
    });

    return {
      orderId: order.id,
      razorpayOrderId: rzpOrder.id,
      amountPaise: order.totalPaise,
      currency: 'INR',
      keyId: this.payments.getPublicKey(),
    };
  }
}
