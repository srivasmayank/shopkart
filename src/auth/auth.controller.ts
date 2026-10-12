import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CredentialsDto } from './auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Body() dto: CredentialsDto) {
    return this.auth.signup(dto.email, dto.password);
  }

  @Post('login')
  login(@Body() dto: CredentialsDto) {
    return this.auth.login(dto.email, dto.password);
  }
}

