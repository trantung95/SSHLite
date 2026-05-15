const { Client } = require('ssh2');
const { monitorEventLoopDelay } = require('perf_hooks');

const HOST = { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', readyTimeout: 5000 };
const SEARCH_ROOT = '/home/testuser';
const HUGE_FILE = '/home/testuser/big/huge.log';
const QUERY = 'a';

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    c.connect(HOST);
  });
}

function getSftp(c) {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function runSearch(client, root, query) {
  const cmd = "grep -rnHI -F -i --include='*' -m 2000 -- '" + query + "' '" + root + "' 2>/dev/null | head -2000";
  return new Promise((resolve, reject) => {
    const sshExec = client['exec'].bind(client);
    sshExec(cmd, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        const out = Buffer.concat(chunks).toString('utf8');
        resolve({ lines: out.split('\n').filter(Boolean).length, bytes: out.length });
      });
      stream.on('error', reject);
    });
  });
}

function readWholeFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = sftp.createReadStream(remotePath);
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}

function startLag() {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  return {
    snap(label) {
      const s = { label, meanMs: +(h.mean / 1e6).toFixed(2), p99Ms: +(h.percentile(99) / 1e6).toFixed(2), maxMs: +(h.max / 1e6).toFixed(2) };
      h.reset();
      return s;
    },
    stop() { h.disable(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function baselineSearchOnly(c) {
  console.log('\n[A] BASELINE search-only');
  const lag = startLag();
  const t0 = now();
  const r = await runSearch(c, SEARCH_ROOT, QUERY);
  const t1 = now();
  const s = lag.snap('A'); lag.stop();
  console.log('  duration=' + (t1 - t0) + 'ms lines=' + r.lines + ' bytes=' + r.bytes + ' lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
  return s;
}

async function baselineReadOnly(c) {
  console.log('\n[B] BASELINE readFile-only (huge.log)');
  const sftp = await getSftp(c);
  const lag = startLag();
  const t0 = now();
  const buf = await readWholeFile(sftp, HUGE_FILE);
  const t1 = now();
  const s = lag.snap('B'); lag.stop();
  console.log('  duration=' + (t1 - t0) + 'ms bytes=' + buf.length + ' lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
  return s;
}

async function clickDuringSearch(c) {
  console.log('\n[C] REPRO click readFile mid-search');
  const sftp = await getSftp(c);
  const lag = startLag();
  const t0 = now();

  const s1 = runSearch(c, '/home/testuser/big', QUERY)
    .then((r) => ({ label: 's1', lines: r.lines, t: now() - t0 }))
    .catch((e) => ({ label: 's1', err: e.message }));
  const s2 = runSearch(c, '/home/testuser/projects', QUERY)
    .then((r) => ({ label: 's2', lines: r.lines, t: now() - t0 }))
    .catch((e) => ({ label: 's2', err: e.message }));

  await sleep(120);
  const tClick = now();
  console.log('  [t+' + (tClick - t0) + 'ms] click readFile(huge.log)');
  const click = readWholeFile(sftp, HUGE_FILE)
    .then((b) => ({ label: 'click', bytes: b.length, t: now() - tClick }))
    .catch((e) => ({ label: 'click', err: e.message }));

  const [r1, r2, rc] = await Promise.all([s1, s2, click]);
  const t1 = now();
  const s = lag.snap('C'); lag.stop();
  console.log('  total=' + (t1 - t0) + 'ms lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
  console.log('  ', JSON.stringify(r1));
  console.log('  ', JSON.stringify(r2));
  console.log('  ', JSON.stringify(rc));
  return s;
}

(async () => {
  let c;
  try {
    console.log('Connecting to ' + HOST.host + ':' + HOST.port + ' as ' + HOST.username);
    c = await connect();
    console.log('Connected.');
    const a = await baselineSearchOnly(c);
    const b = await baselineReadOnly(c);
    const cc = await clickDuringSearch(c);
    console.log('\n=== SUMMARY (event-loop lag ms) ===');
    console.log('  [A] search-only       mean=' + a.meanMs + ' p99=' + a.p99Ms + ' max=' + a.maxMs);
    console.log('  [B] readFile-only     mean=' + b.meanMs + ' p99=' + b.p99Ms + ' max=' + b.maxMs);
    console.log('  [C] click-mid-search  mean=' + cc.meanMs + ' p99=' + cc.p99Ms + ' max=' + cc.maxMs);
    console.log('\nVS Code ext-host watchdog ~10000ms. Sustained max>1000ms in C while A/B are small would support saturation hypothesis.');
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (c) c.end();
  }
})();
