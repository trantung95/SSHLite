// v2: heavier load — grep without -m, on huge.log so it streams ~30MB of output.
// Run two concurrent grep streams + simultaneous readFile, like the real
// production path with parallelProcesses=2.
const { Client } = require('ssh2');
const { monitorEventLoopDelay } = require('perf_hooks');

const HOST = { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', readyTimeout: 5000 };

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

// Production-like: grep with line numbers + filename + literal, NO -m so we
// stream the full match set. The huge.log alone yields ~800k matching lines.
function heavyGrep(client, target) {
  const cmd = "grep -rnHI -F -i --include='*' -- 'a' '" + target + "' 2>/dev/null";
  return new Promise((resolve, reject) => {
    const sshExec = client['exec'].bind(client);
    sshExec(cmd, (err, stream) => {
      if (err) return reject(err);
      let bytes = 0;
      stream.on('data', (d) => { bytes += d.length; });
      stream.stderr.on('data', () => {});
      stream.on('close', () => resolve({ bytes }));
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

(async () => {
  let c;
  try {
    console.log('Connecting...');
    c = await connect();
    console.log('Connected.');

    // [A] heavy grep on the 49MB file, alone
    console.log('\n[A] heavy grep on /home/testuser/big (no -m)');
    {
      const lag = startLag(); const t0 = now();
      const r = await heavyGrep(c, '/home/testuser/big');
      const t1 = now(); const s = lag.snap('A'); lag.stop();
      console.log('  duration=' + (t1 - t0) + 'ms outputBytes=' + r.bytes + ' lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
    }

    // [B] readFile alone
    console.log('\n[B] readFile huge.log alone');
    {
      const sftp = await getSftp(c);
      const lag = startLag(); const t0 = now();
      const buf = await readWholeFile(sftp, '/home/testuser/big/huge.log');
      const t1 = now(); const s = lag.snap('B'); lag.stop();
      console.log('  duration=' + (t1 - t0) + 'ms bytes=' + buf.length + ' lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
    }

    // [C] two concurrent heavy greps + readFile midway through
    console.log('\n[C] REPRO 2 heavy greps + readFile mid-flight');
    {
      const sftp = await getSftp(c);
      const lag = startLag(); const t0 = now();

      const g1 = heavyGrep(c, '/home/testuser/big').then(r => ({ label: 'g1', ...r, t: now() - t0 })).catch(e => ({ err: e.message }));
      const g2 = heavyGrep(c, '/home/testuser/big').then(r => ({ label: 'g2', ...r, t: now() - t0 })).catch(e => ({ err: e.message }));

      await sleep(200);
      const tc = now();
      console.log('  [t+' + (tc - t0) + 'ms] click readFile(huge.log)');
      const click = readWholeFile(sftp, '/home/testuser/big/huge.log').then(b => ({ label: 'click', bytes: b.length, t: now() - tc })).catch(e => ({ err: e.message }));

      const [r1, r2, rc] = await Promise.all([g1, g2, click]);
      const t1 = now(); const s = lag.snap('C'); lag.stop();
      console.log('  total=' + (t1 - t0) + 'ms lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
      console.log(' ', JSON.stringify(r1));
      console.log(' ', JSON.stringify(r2));
      console.log(' ', JSON.stringify(rc));
    }

    // [D] same as C but with 4 concurrent greps (worst case if user has cranked searchParallelProcesses)
    console.log('\n[D] REPRO 4 heavy greps + readFile mid-flight');
    {
      const sftp = await getSftp(c);
      const lag = startLag(); const t0 = now();
      const targets = ['/home/testuser/big', '/home/testuser/big', '/home/testuser/big', '/home/testuser/big'];
      const greps = targets.map((t, i) => heavyGrep(c, t).then(r => ({ label: 'g' + i, ...r, t: now() - t0 })).catch(e => ({ err: e.message })));
      await sleep(200);
      const tc = now();
      console.log('  [t+' + (tc - t0) + 'ms] click readFile(huge.log)');
      const click = readWholeFile(sftp, '/home/testuser/big/huge.log').then(b => ({ label: 'click', bytes: b.length, t: now() - tc })).catch(e => ({ err: e.message }));
      const all = await Promise.all([...greps, click]);
      const t1 = now(); const s = lag.snap('D'); lag.stop();
      console.log('  total=' + (t1 - t0) + 'ms lag mean=' + s.meanMs + ' p99=' + s.p99Ms + ' max=' + s.maxMs);
      for (const r of all) console.log(' ', JSON.stringify(r));
    }
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    if (c) c.end();
  }
})();
