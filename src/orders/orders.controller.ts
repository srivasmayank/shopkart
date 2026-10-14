import {
  Body,
  Controller,
  Get,
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
}

