import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getStatus(): { status: string; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'shopkart-api',
      timestamp: new Date().toISOString(),
    };
  }
}

