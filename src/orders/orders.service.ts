import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './orders.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Chapter 4.7: The naive implementation that reads stock, checks it, then writes
   * a value computed from the earlier read. Under concurrency, this exhibits the
   * classic "check-then-act" lost update race condition.
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

      // Flawed step: computes new stock based on stale read and overwrites
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
        items: {
          create: lines,
        },
      },
      include: {
        items: true,
      },
    });
  }

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
}

