const { verifyData } = require('../db');

async function main() {
  try {
    console.log('Verifying sample data...\n');
    const result = await verifyData();

    console.log('=== Data Statistics ===');
    console.log(`  Users: ${result.results.users}`);
    console.log(`  User roles: ${result.results.roles.map(r => `${r.role}(${r.count})`).join(', ')}`);
    console.log(`  Devices: ${result.results.devices}`);
    console.log(`  Device types: ${result.results.device_types}`);
    console.log(`  Areas: ${result.results.areas}`);
    console.log(`  Templates: ${result.results.templates}`);
    console.log(`  Plans: ${result.results.plans}`);
    console.log(`  Holidays: ${result.results.holidays}`);
    console.log(`  Inspection points: ${result.results.points}`);

    console.log('\n=== Data Validation ===');
    let passed = 0;
    let failed = 0;
    for (const check of result.checks) {
      if (check.pass) {
        console.log(`  ✅ ${check.name}`);
        passed++;
      } else {
        console.log(`  ❌ ${check.name}`);
        failed++;
      }
    }

    console.log(`\nResult: ${passed} passed, ${failed} failed`);

    if (result.allPassed) {
      console.log('\nAll data validation checks passed!');
      process.exit(0);
    } else {
      console.error('\nSome validation checks failed!');
      process.exit(1);
    }
  } catch (e) {
    console.error('Failed to verify data:', e.message);
    process.exit(1);
  }
}

main();
