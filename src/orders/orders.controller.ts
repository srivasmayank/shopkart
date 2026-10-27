import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './orders.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, JwtUser } from '../auth/current-user.decorator';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Chapter 4.8 & 4.9: Production order checkout.
   * Requires Idempotency-Key header; executes atomic conditional update in transaction.
   */
  @Post()
  create(
    @CurrentUser() user: JwtUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateOrderDto,
  ) {
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.orders.placeOrder(user.sub, key, dto);
  }

  /**
   * Chapter 4.7: Naive checkout endpoint preserved for race condition demonstration.
   */
  @Post('naive')
  createNaive(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.placeOrderNaive(user.sub, dto);
  }

  @Get()
  listMine(@CurrentUser() user: JwtUser) {
    return this.orders.listMine(user.sub);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.orders.findMine(user.sub, id);
  }

  /**
   * Chapter 5.2: Initiates payment for an order.
   * Generates or fetches an idempotent Razorpay order in paise for the client checkout.
   */
  @Post(':id/pay')
  pay(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.orders.createPaymentOrder(user.sub, id);
  }
}
