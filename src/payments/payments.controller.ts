import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { OrdersService } from '../orders/orders.service';

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

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
   * Chapter 5.4 - 5.6: Webhook receiver endpoint.
   * Receives asynchronous payment event notifications from Razorpay (e.g. order.paid, payment.captured, payment.failed).
   * Validates raw body HMAC-SHA256 signature against RAZORPAY_WEBHOOK_SECRET.
   * Executes strict state machine transitions with single-statement conditional updates.
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
    const eventType = event?.event;
    this.logger.log(`Processing verified Razorpay webhook: "${eventType}"`);

    const paymentEntity = event?.payload?.payment?.entity;
    const orderEntity = event?.payload?.order?.entity;
    const razorpayOrderId = orderEntity?.id || paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;

    if (eventType === 'order.paid' || eventType === 'payment.captured') {
      if (!razorpayOrderId) {
        throw new BadRequestException('Missing razorpay order ID in webhook payload');
      }
      const result = await this.orders.markOrderPaid(razorpayOrderId, paymentId);
      return {
        received: true,
        event: eventType,
        action: result.status,
        orderId: result.order.id,
        status: result.order.status,
      };
    }

    if (eventType === 'payment.failed') {
      if (!razorpayOrderId) {
        throw new BadRequestException('Missing razorpay order ID in webhook payload');
      }
      const result = await this.orders.cancelOrder({
        razorpayOrderId,
        reason: `Payment failed: ${paymentEntity?.error_description || 'Gateway failure'}`,
      });
      return {
        received: true,
        event: eventType,
        action: result.status,
        orderId: result.order.id,
        status: result.order.status,
      };
    }

    return {
      received: true,
      event: eventType,
      action: 'IGNORED',
    };
  }
}

