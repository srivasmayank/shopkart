import http from 'node:http';
import { createHmac } from 'node:crypto';

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_webhook_secret_shopkart2026';

function sendWebhook(payload) {
  const data = JSON.stringify(payload);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(data).digest('hex');

  const req = http.request(
    'http://localhost:3000/payments/webhook',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-razorpay-signature': signature,
      },
    },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        console.log(`📡 Webhook delivery response [${res.statusCode}]: ${body}`);
      });
    },
  );

  req.on('error', (err) => {
    console.error(`❌ Webhook delivery error: ${err.message}`);
  });

  req.write(data);
  req.end();
}

console.log('Sending sample Razorpay "order.paid" event...');
sendWebhook({
  entity: 'event',
  account_id: 'acc_shopkart_test',
  event: 'order.paid',
  contains: ['payment', 'order'],
  payload: {
    payment: {
      entity: {
        id: 'pay_test_987654321',
        amount: 999800,
        currency: 'INR',
        status: 'captured',
        order_id: 'order_mock_test123',
      },
    },
    order: {
      entity: {
        id: 'order_mock_test123',
        amount: 999800,
        amount_paid: 999800,
        amount_due: 0,
        currency: 'INR',
        receipt: 'order_rcpt_1',
        status: 'paid',
      },
    },
  },
  created_at: Math.floor(Date.now() / 1000),
});

