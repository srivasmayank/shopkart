const BASE = 'http://localhost:3000';

async function runTests() {
  console.log('🧪 Starting Day 4 Catalog & Orders (Naive) Test Suite...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // Login as admin and customer to obtain tokens
  const adminRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'asha@test.com', password: 'secret123' }),
  });
  const { accessToken: adminToken } = await adminRes.json();

  const customerRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ravi@test.com', password: 'secret123' }),
  });
  const { accessToken: customerToken } = await customerRes.json();

  // Test 1: Public catalog listing
  const listRes = await fetch(`${BASE}/products`);
  const products = await listRes.json();
  assert(listRes.status === 200 && Array.isArray(products) && products.length >= 3, 'GET /products is public and returns items');

  const testProduct = products[0];

  // Test 2: Public single product retrieval
  const singleRes = await fetch(`${BASE}/products/${testProduct.id}`);
  const singleProduct = await singleRes.json();
  assert(singleRes.status === 200 && singleProduct.id === testProduct.id, `GET /products/${testProduct.id} returns single product`);

  // Test 3: POST /products unauthenticated returns 401
  const unauthProdRes = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sneakers', pricePaise: 199900, stock: 5 }),
  });
  assert(unauthProdRes.status === 401, 'POST /products without token returns 401');

  // Test 4: POST /products with customer token returns 403 Forbidden
  const forbiddenProdRes = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({ name: 'Sneakers', pricePaise: 199900, stock: 5 }),
  });
  assert(forbiddenProdRes.status === 403, 'POST /products with CUSTOMER token returns 403 Forbidden');

  // Test 5: POST /products with admin token succeeds
  const createProdRes = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ name: 'Trail Runners', pricePaise: 349900, stock: 15 }),
  });
  const createdProd = await createProdRes.json();
  assert(createProdRes.status === 201 && createdProd.name === 'Trail Runners' && createdProd.stock === 15, 'POST /products with ADMIN token creates product');

  // Test 6: POST /orders/naive unauthenticated returns 401
  const unauthOrderRes = await fetch(`${BASE}/orders/naive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: testProduct.id, quantity: 1 }] }),
  });
  assert(unauthOrderRes.status === 401, 'POST /orders/naive without token returns 401');

  // Test 7: Validation failure (quantity < 1 or empty items)
  const badOrderRes = await fetch(`${BASE}/orders/naive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({ items: [] }),
  });
  assert(badOrderRes.status === 400, 'POST /orders/naive with empty items array returns 400 Bad Request');

  // Test 8: Successful naive order placement
  const initialStock = testProduct.stock;
  const naiveOrderRes = await fetch(`${BASE}/orders/naive`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`,
    },
    body: JSON.stringify({
      items: [{ productId: testProduct.id, quantity: 2 }],
    }),
  });
  const orderData = await naiveOrderRes.json();
  assert(
    naiveOrderRes.status === 201 &&
    orderData.status === 'PAYMENT_PENDING' &&
    orderData.totalPaise === testProduct.pricePaise * 2 &&
    orderData.items.length === 1,
    'POST /orders/naive successfully creates order with correct paise total and PAYMENT_PENDING status',
  );

  // Verify stock decremented
  const updatedProductRes = await fetch(`${BASE}/products/${testProduct.id}`);
  const updatedProduct = await updatedProductRes.json();
  assert(updatedProduct.stock === initialStock - 2, `Product stock was decremented from ${initialStock} to ${updatedProduct.stock}`);

  // Test 9: GET /orders returns user order list
  const listOrdersRes = await fetch(`${BASE}/orders`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const myOrders = await listOrdersRes.json();
  assert(listOrdersRes.status === 200 && Array.isArray(myOrders) && myOrders.some(o => o.id === orderData.id), 'GET /orders lists user orders');

  // Test 10: GET /orders/:id returns the specific order
  const singleOrderRes = await fetch(`${BASE}/orders/${orderData.id}`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const singleOrder = await singleOrderRes.json();
  assert(singleOrderRes.status === 200 && singleOrder.id === orderData.id, `GET /orders/${orderData.id} retrieves single order`);

  console.log(`\n🏁 Test Run Completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

