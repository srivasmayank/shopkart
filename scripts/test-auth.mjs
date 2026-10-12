const BASE = 'http://localhost:3000';

async function runTests() {
  console.log('🧪 Starting Day 3 Authentication & Authorization Test Suite...\n');

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

  // Test 1: Validation failure (password < 8 chars)
  const badSignupRes = await fetch(`${BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'short@test.com', password: '123' }),
  });
  assert(badSignupRes.status === 400, 'Password < 8 chars returns 400 Bad Request');

  // Test 2: Valid signup
  const uniqueEmail = `test_${Date.now()}@example.com`;
  const signupRes = await fetch(`${BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: uniqueEmail, password: 'password123' }),
  });
  const signupData = await signupRes.json();
  assert(signupRes.status === 201 && typeof signupData.accessToken === 'string', 'Valid signup returns 201 and accessToken');

  // Test 3: Duplicate signup rejection (P2002 conflict)
  const dupSignupRes = await fetch(`${BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: uniqueEmail, password: 'password123' }),
  });
  assert(dupSignupRes.status === 409, 'Duplicate email signup returns 409 Conflict');

  // Test 4: Login with seeded customer (ravi@test.com)
  const customerLoginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ravi@test.com', password: 'secret123' }),
  });
  const customerData = await customerLoginRes.json();
  assert(customerLoginRes.status === 201 && typeof customerData.accessToken === 'string', 'Customer login returns 201 with accessToken');
  const customerToken = customerData.accessToken;

  // Test 5: Login with wrong password
  const wrongPassRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ravi@test.com', password: 'wrongpassword' }),
  });
  assert(wrongPassRes.status === 401, 'Wrong password returns 401 Unauthorized');

  // Test 6: Login with non-existent email (anti-enumeration check)
  const unknownUserRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@test.com', password: 'secret123' }),
  });
  const unknownData = await unknownUserRes.json();
  const wrongPassData = await wrongPassRes.json();
  assert(
    unknownUserRes.status === 401 && unknownData.message === wrongPassData.message,
    'Unknown email returns identical 401 message (prevents user enumeration)',
  );

  // Test 7: Login with seeded admin (asha@test.com)
  const adminLoginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'asha@test.com', password: 'secret123' }),
  });
  const adminData = await adminLoginRes.json();
  assert(adminLoginRes.status === 201 && typeof adminData.accessToken === 'string', 'Admin login returns 201 with accessToken');
  const adminToken = adminData.accessToken;

  // Test 8: Protected /me route without token
  const noTokenRes = await fetch(`${BASE}/me`);
  assert(noTokenRes.status === 401, 'Unauthenticated request to /me returns 401 Unauthorized');

  // Test 9: Protected /me route with valid customer token
  const meRes = await fetch(`${BASE}/me`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const meData = await meRes.json();
  assert(
    meRes.status === 200 && meData.user.role === 'CUSTOMER',
    'Customer accesses /me and receives verified claims (sub & role)',
  );

  // Test 10: Admin route access control (Customer blocked)
  const customerAdminRes = await fetch(`${BASE}/admin/dashboard`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert(customerAdminRes.status === 403, 'Customer blocked from /admin/dashboard with 403 Forbidden');

  // Test 11: Admin route access control (Admin allowed)
  const adminDashboardRes = await fetch(`${BASE}/admin/dashboard`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const adminDashboardData = await adminDashboardRes.json();
  assert(
    adminDashboardRes.status === 200 && adminDashboardData.adminUser.role === 'ADMIN',
    'Admin successfully accesses /admin/dashboard with 200 OK',
  );

  console.log(`\n🏁 Test Run Completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

