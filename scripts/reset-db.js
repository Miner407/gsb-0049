const { resetDatabase } = require('../db');

async function main() {
  try {
    console.log('Resetting database... (all data will be lost)');
    await resetDatabase();
    console.log('Database reset successfully.');
    console.log('All tables recreated and sample data restored.');
    process.exit(0);
  } catch (e) {
    console.error('Failed to reset database:', e.message);
    process.exit(1);
  }
}

main();
