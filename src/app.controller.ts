import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AdminGuard } from './auth/admin.guard';
import { CurrentUser, JwtUser } from './auth/current-user.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getStatus();
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() user: JwtUser) {
    return {
      message: 'Authenticated profile accessed',
      user,
    };
  }

  @Get('admin/dashboard')
  @UseGuards(JwtAuthGuard, AdminGuard)
  getAdminDashboard(@CurrentUser() user: JwtUser) {
    return {
      message: 'Welcome to admin dashboard',
      adminUser: user,
    };
  }
}

