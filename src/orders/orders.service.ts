import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { CreateOrderDto } from './orders.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => PaymentsService))
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

  /**
   * Chapter 5.5: Order State Machine transition: PAYMENT_PENDING -> PAID.
   * Enforced via single-statement conditional update to prevent race conditions.
   * Idempotent: duplicate webhook deliveries return existing order without error.
   */
  async markOrderPaid(razorpayOrderId: string, paymentId?: string) {
    // 1. Conditional update: only update if status is currently PAYMENT_PENDING
    const updateResult = await this.prisma.order.updateMany({
      where: {
        razorpayOrderId,
        status: OrderStatus.PAYMENT_PENDING,
      },
      data: {
        status: OrderStatus.PAID,
        razorpayPaymentId: paymentId ?? null,
      },
    });

    if (updateResult.count === 1) {
      const order = await this.prisma.order.findUniqueOrThrow({
        where: { razorpayOrderId },
        include: { items: true },
      });
      this.logger.log(
        `Order #${order.id} transitioned PAYMENT_PENDING -> PAID (razorpayOrderId: ${razorpayOrderId}, paymentId: ${paymentId})`,
      );
      return { status: 'TRANSITIONED', order };
    }

    // 2. If 0 rows updated, verify current state
    const existing = await this.prisma.order.findUnique({
      where: { razorpayOrderId },
      include: { items: true },
    });

    if (!existing) {
      throw new NotFoundException(`Order with Razorpay order ID ${razorpayOrderId} not found`);
    }

    if (existing.status === OrderStatus.PAID) {
      this.logger.log(`Webhook replay: Order #${existing.id} is already PAID`);
      return { status: 'ALREADY_PAID', order: existing };
    }

    // Strict state guard: cannot mark CANCELLED or other status as PAID
    this.logger.warn(
      `Illegal transition attempt: Order #${existing.id} is in status ${existing.status}, cannot transition to PAID`,
    );
    throw new ConflictException(
      `Order #${existing.id} is in status ${existing.status} and cannot be marked as PAID`,
    );
  }

  /**
   * Chapter 5.5 & 5.6: Order State Machine transition: PAYMENT_PENDING -> CANCELLED.
   * 1. State Guard: Only PAYMENT_PENDING orders can be cancelled.
   * 2. Single-statement conditional update: status = 'CANCELLED' WHERE status = 'PAYMENT_PENDING'.
   * 3. Atomically restores reserved product inventory inside the transaction.
   * 4. Double-restoration protection: if order is already CANCELLED, returns immediately.
   */
  async cancelOrder(options: {
    orderId?: number;
    razorpayOrderId?: string;
    userId?: number;
    reason?: string;
  }) {
    return await this.prisma.$transaction(async (tx) => {
      const whereClause: Prisma.OrderWhereInput = {};
      if (options.orderId) whereClause.id = options.orderId;
      if (options.razorpayOrderId) whereClause.razorpayOrderId = options.razorpayOrderId;
      if (options.userId) whereClause.userId = options.userId;

      const order = await tx.order.findFirst({
        where: whereClause,
        include: { items: true },
      });

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      // Idempotency: if already CANCELLED, do NOT restore stock again
      if (order.status === OrderStatus.CANCELLED) {
        this.logger.log(`Order #${order.id} is already CANCELLED`);
        return { status: 'ALREADY_CANCELLED', order };
      }

      // Strict state guard: cannot cancel a PAID order without a refund process
      if (order.status !== OrderStatus.PAYMENT_PENDING) {
        throw new ConflictException(
          `Cannot cancel order #${order.id} with status ${order.status}. Only PAYMENT_PENDING orders can be cancelled.`,
        );
      }

      // Atomic conditional update
      const updateRes = await tx.order.updateMany({
        where: {
          id: order.id,
          status: OrderStatus.PAYMENT_PENDING,
        },
        data: {
          status: OrderStatus.CANCELLED,
        },
      });

      if (updateRes.count === 0) {
        throw new ConflictException(`Concurrent status modification on order #${order.id}`);
      }

      // Atomically restore product stock
      for (const item of order.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }

      this.logger.log(
        `Order #${order.id} cancelled. Restored stock for ${order.items.length} line items. Reason: ${options.reason ?? 'None provided'}`,
      );

      const updatedOrder = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });

      return { status: 'CANCELLED', order: updatedOrder };
    });
  }
}
