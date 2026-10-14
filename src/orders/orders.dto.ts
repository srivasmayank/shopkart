import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderItemDto {
  @IsInt()
  productId: number;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity: number;
}

export class CreateOrderDto {
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  @ArrayMinSize(1)
  items: OrderItemDto[];
}

