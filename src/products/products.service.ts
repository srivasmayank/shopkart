import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './products.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.product.findMany({
      orderBy: { id: 'asc' },
    });
  }

  async get(id: number) {
    const product = await this.prisma.product.findUnique({
      where: { id },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: dto,
    });
  }
}

