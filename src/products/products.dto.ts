import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  @Min(0)
  pricePaise: number;

  @IsInt()
  @Min(0)
  stock: number;
}

