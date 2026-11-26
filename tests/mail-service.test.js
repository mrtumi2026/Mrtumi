'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { sendMail, getMailConfig } = require('../src/services/mailService');

test('sendMail delivers through a real SMTP conversation on a local stub server', async () => {
  let received = '';
  const server = net.createServer((sock) => {
    let data = false; let buf = '';
    sock.write('220 stub\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; sock.write('250 queued\r\n'); } else received += `${line}\n`; continue; }
        if (/^EHLO/i.test(line)) sock.write('250-stub\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write('235 ok\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = await sendMail(
      { to: 'buyer@example.test', subject: 'Stub', text: 'hello-stub' },
      { settings: { smtp_host: '127.0.0.1', smtp_port: String(server.address().port), smtp_user: 'u', smtp_pass: 'p', smtp_from_email: 'shop@example.test' } }
    );
    assert.strictEqual(result.delivered, true);
    assert.match(received, /hello-stub/);
    assert.match(received, /shop@example\.test/);
  } finally { server.close(); }
});

test('mail stays disabled without a verified sender email', async () => {
  const config = await getMailConfig({ smtp_host: 'smtp.example.test', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p' });
  assert.deepStrictEqual(config.missing, ['Verified sender email']);
});
