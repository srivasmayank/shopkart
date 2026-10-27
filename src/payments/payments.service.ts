import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Razorpay from 'razorpay';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export interface RazorpayOrderResult {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private razorpay: Razorpay;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly isMockMode: boolean;

  constructor(private readonly config: ConfigService) {
    this.keyId = this.config.get<string>('RAZORPAY_KEY_ID', 'rzp_test_placeholder');
    this.keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET', 'secret_placeholder');
    this.webhookSecret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET', 'webhook_secret_placeholder');

    // Enable mock mode when running with placeholders or offline test keys
    this.isMockMode =
      this.keyId.includes('placeholder') ||
      this.keyId.includes('shopkart2026') ||
      process.env.NODE_ENV === 'test';

    if (this.isMockMode) {
      this.logger.log('PaymentsService initialized in MOCK MODE (offline deterministic Razorpay orders)');
    } else {
      this.razorpay = new Razorpay({
        key_id: this.keyId,
        key_secret: this.keySecret,
      });
      this.logger.log(`PaymentsService initialized with Razorpay Key ID: ${this.keyId.slice(0, 8)}...`);
    }
  }

  getPublicKey(): string {
    return this.keyId;
  }

  /**
   * Chapter 5.2: Creates a Razorpay Order in integer paise.
   * Never passes floating point amounts to prevent currency truncation.
   */
  async createRazorpayOrder(
    amountPaise: number,
    receipt: string,
    notes?: Record<string, string>,
  ): Promise<RazorpayOrderResult> {
    if (this.isMockMode) {
      return {
        id: `order_mock_${randomBytes(8).toString('hex')}`,
        amount: amountPaise,
        currency: 'INR',
        receipt,
      };
    }

    try {
      const order = await this.razorpay.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes,
      });

      return {
        id: order.id,
        amount: Number(order.amount),
        currency: order.currency,
        receipt: order.receipt ?? receipt,
      };
    } catch (err: any) {
      this.logger.error(`Failed to create Razorpay order: ${err?.message || err}`);
      throw err;
    }
  }

  /**
   * Chapter 5.4: Constant-time HMAC-SHA256 signature verification for webhooks.
   * Defends against timing attacks via crypto.timingSafeEqual.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    if (this.isMockMode && signature === 'mock-valid-signature') {
      return true;
    }

    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      hmac.update(rawBody);
      const expectedSignature = hmac.digest('hex');

      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
      const actualBuffer = Buffer.from(signature, 'utf8');

      if (expectedBuffer.length !== actualBuffer.length) {
        return false;
      }

      return timingSafeEqual(expectedBuffer, actualBuffer);
    } catch {
      return false;
    }
  }
}

