import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Clean existing seed data
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();

  // Create default admin and customer
  const passwordHash = await bcrypt.hash('secret123', 12);

  const admin = await prisma.user.create({
    data: {
      email: 'asha@test.com',
      passwordHash,
      role: Role.ADMIN,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'ravi@test.com',
      passwordHash,
      role: Role.CUSTOMER,
    },
  });

  // Seed sample products with integer paise pricing
  const shoes = await prisma.product.create({
    data: {
      name: 'Running Shoes',
      pricePaise: 249900, // ₹2,499.00
      stock: 10,
    },
  });

  const backpack = await prisma.product.create({
    data: {
      name: 'Waterproof Backpack',
      pricePaise: 129900, // ₹1,299.00
      stock: 25,
    },
  });

  const cap = await prisma.product.create({
    data: {
      name: 'Sports Cap',
      pricePaise: 49900, // ₹499.00
      stock: 50,
    },
  });

  console.log('✅ Seed completed successfully:');
  console.log(`   Admin: ${admin.email} (password: secret123)`);
  console.log(`   Customer: ${customer.email} (password: secret123)`);
  console.log(`   Products created: "${shoes.name}", "${backpack.name}", "${cap.name}"`);
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

