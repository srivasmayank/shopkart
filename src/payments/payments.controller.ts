import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  /**
   * Returns the public Razorpay Key ID for client-side checkout integration.
   */
  @Get('public-key')
  getPublicKey() {
    return {
      keyId: this.payments.getPublicKey(),
    };
  }

  /**
   * Chapter 5.4: Webhook receiver endpoint.
   * Receives asynchronous payment event notifications from Razorpay (e.g. order.paid, payment.captured).
   * Validates raw body HMAC-SHA256 signature against RAZORPAY_WEBHOOK_SECRET.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing x-razorpay-signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Raw request body is required for signature validation');
    }

    const isValid = this.payments.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      this.logger.warn('Rejected webhook: invalid HMAC-SHA256 signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = req.body;
    this.logger.log(`Received verified Razorpay webhook event: "${event?.event}"`);

    return {
      received: true,
      event: event?.event,
    };
  }
}

