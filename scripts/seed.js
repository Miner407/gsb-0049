const { seedData } = require('../db');

async function main() {
  try {
    console.log('Seeding sample data...');
    await seedData();
    console.log('Sample data seeded successfully.');
    process.exit(0);
  } catch (e) {
    console.error('Failed to seed data:', e.message);
    process.exit(1);
  }
}

main();
