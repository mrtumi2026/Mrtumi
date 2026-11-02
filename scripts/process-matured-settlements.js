'use strict';

/** One-shot settlement runner. It is deliberately inert unless --apply is supplied. */
const settlementRepository = require('../src/repositories/partnerSettlementRepository');
const mysql = require('../src/db/mysqlPool');

function parseArgs(argv) {
  const options = { apply: false, returnWindowDays: 7 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') options.apply = true;
    else if (argv[index] === '--return-window-days') {
      const days = Number(argv[++index]);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('--return-window-days must be an integer from 0 to 365.');
      options.returnWindowDays = days;
    } else if (argv[index] === '--help') {
      console.log('Usage: node scripts/process-matured-settlements.js --apply [--return-window-days 7]');
      return { ...options, help: true };
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return;
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'dry-run', applied: false, returnWindowDays: options.returnWindowDays,
      message: 'No settlement was released. Supply --apply after reviewing operational controls.' }));
    return;
  }
  const result = await settlementRepository.processMaturedSettlements({ returnWindowDays: options.returnWindowDays, actor: { type: 'system' } });
  console.log(JSON.stringify({ ...result, mode: 'apply' }));
})().catch((error) => {
  console.error(`Matured settlement processing failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await mysql.closePool();
});
