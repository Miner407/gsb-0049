const { initDatabase } = require('../db');

async function main() {
  try {
    console.log('Initializing database...');
    await initDatabase();
    console.log('Database initialized successfully.');
    console.log('Database file: inspection.db');
    process.exit(0);
  } catch (e) {
    console.error('Failed to initialize database:', e.message);
    process.exit(1);
  }
}

main();
