'use strict';

/** One-shot reservation expiry runner. Dry-run is the default; use --apply only after operational approval. */
const phase08 = require('../src/repositories/phase08Repository');
const mysql = require('../src/db/mysqlPool');

function parseArgs(argv) {
  const options = { apply: false, limit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--limit') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error('--limit must be an integer from 1 to 1000.');
      options.limit = value;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply) {
    const candidates = await phase08.listExpiredOrderReservationCandidates({ limit: options.limit });
    console.log(JSON.stringify({ mode: 'dry-run', candidateOrders: candidates.length, candidateReservationRows: candidates.reduce((sum, row) => sum + Number(row.reservation_rows), 0), limit: options.limit }));
    return;
  }
  const result = await phase08.expireExpiredOrderReservations({ limit: options.limit });
  console.log(JSON.stringify({ ...result, mode: 'apply' }));
})().catch((error) => {
  console.error(`Reservation expiry failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await mysql.closePool();
});
