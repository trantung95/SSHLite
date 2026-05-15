// Reproduce the file-watcher poll re-downloading the full file every 1s.
// Drives FileService.refreshSingleFile's else-branch: stat() then full
// readFile() because currentSize == previousSize (file unchanged).
// Measures: heap growth, total SSH bytes pulled, time per poll.
const { Client } = require('ssh2');
const v8 = require('v8');

const HOST = { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', readyTimeout: 5000 };
const FILE = '/home/testuser/big/huge.log';
const POLL_INTERVAL_MS = 1000;
const RUN_SECONDS = 60;

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
function statFile(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, s) => (err ? reject(err) : resolve(s)));
  });
}
function readFile(sftp, p) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = sftp.createReadStream(p);
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}
function heapMB() {
  const h = v8.getHeapStatistics();
  return {
    used: +(h.used_heap_size / 1e6).toFixed(1),
    total: +(h.total_heap_size / 1e6).toFixed(1),
    limit: +(h.heap_size_limit / 1e6).toFixed(0),
  };
}

(async () => {
  console.log('Connecting...');
  const c = await connect();
  const sftp = await getSftp(c);

  // Initial download — same as openRemoteFile's first readFile
  console.log('Initial download...');
  const t0 = Date.now();
  let originalBuf = await readFile(sftp, FILE);
  let originalContent = originalBuf.toString('utf-8');
  let lastRemoteSize = originalBuf.length;
  console.log(`Initial: ${originalBuf.length} bytes, ${Date.now() - t0}ms, heap=${JSON.stringify(heapMB())}`);

  let totalDownloaded = originalBuf.length;
  let pollCount = 0;
  const startedAt = Date.now();

  // Mimic FileService.refreshSingleFile every 1s
  const t = setInterval(async () => {
    pollCount++;
    const tPoll = Date.now();
    try {
      const stats = await statFile(sftp, FILE);
      const currentSize = stats.size;
      let content;
      // Same condition as refreshSingleFile line 2391:
      // if (smartThreshold > 0 && previousSize > 0 && currentSize > smartThreshold && currentSize > previousSize)
      // Default smartThreshold = ? Let me assume default (always enabled for big files).
      // For unchanged file, currentSize === previousSize, so this is FALSE.
      // Fall through to else branch: full re-download.
      content = await readFile(sftp, FILE);
      totalDownloaded += content.length;
      const newContent = content.toString('utf-8');
      const changed = newContent !== originalContent;
      const dl = Date.now() - tPoll;
      const h = heapMB();
      console.log(`poll #${pollCount} t+${Math.round((Date.now() - startedAt) / 1000)}s: downloaded ${content.length}B in ${dl}ms changed=${changed} cumulative=${(totalDownloaded / 1e6).toFixed(0)}MB heap used=${h.used}MB total=${h.total}MB`);
      // Don't update lastRemoteSize variable here; replicating FileService logic
      lastRemoteSize = currentSize;
    } catch (e) {
      console.log(`poll #${pollCount} error: ${e.message}`);
    }

    if ((Date.now() - startedAt) / 1000 >= RUN_SECONDS) {
      clearInterval(t);
      console.log(`\n=== After ${RUN_SECONDS}s, ${pollCount} polls, ${(totalDownloaded / 1e6).toFixed(0)}MB total downloaded, heap=${JSON.stringify(heapMB())} ===`);
      c.end();
      process.exit(0);
    }
  }, POLL_INTERVAL_MS);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
