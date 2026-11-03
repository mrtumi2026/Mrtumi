'use strict';

function closeHttpServer(server, timeoutMs = 5000) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); }
      catch (error) { return finish(error); }
      finish(new Error(`HTTP server close exceeded ${timeoutMs}ms; active connections were force-closed.`));
    }, timeoutMs);
    server.close(finish);
    try { server.closeAllConnections?.(); }
    catch (error) { finish(error); }
  });
}

async function closeBrowser(browser, timeoutMs = 10000) {
  if (!browser) return;
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Browser close exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    try { browser.process?.()?.kill('SIGKILL'); } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupE2eResources({ browser, server, pool, resetDatabase, closePool }) {
  const errors = [];
  try { await closeBrowser(browser); }
  catch (error) { errors.push({ resource: 'browser', error }); }
  try { await closeHttpServer(server); }
  catch (error) { errors.push({ resource: 'server', error }); }
  if (pool) {
    try {
      if (resetDatabase) await resetDatabase(pool);
    } catch (error) {
      errors.push({ resource: 'database-reset', error });
    } finally {
      try { await closePool(pool); }
      catch (error) { errors.push({ resource: 'database-pool', error }); }
    }
  }
  return errors;
}

module.exports = { closeHttpServer, closeBrowser, cleanupE2eResources };
