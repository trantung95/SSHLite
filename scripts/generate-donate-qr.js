// One-shot generator for the donate QR PNGs (4 chains: USDT, SOL, BNB, TON)
// with each chain's logo overlaid at the center.
//
// Run: npm i --no-save qrcode sharp && node scripts/generate-donate-qr.js
//
// Inputs (must exist before running): docs/images/donate/<id>-logo-temp.png
//   - usdt-logo-temp.png  -> from spothq/cryptocurrency-icons (BSD-3-Clause)
//   - sol-logo-temp.png   -> from spothq/cryptocurrency-icons (BSD-3-Clause)
//   - bnb-logo-temp.png   -> from spothq/cryptocurrency-icons (BSD-3-Clause)
//   - ton-logo-temp.png   -> from trustwallet/assets (MIT)
//
// Outputs: docs/images/donate/{usdt,sol,bnb,ton}-qr.png

const QRCode = require('qrcode');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'images', 'donate');

const CHAINS = [
  { id: 'usdt', address: 'GURgJGXeFfbV9S4Kr1xgxCrS367w3gkCuuS8up7xiDEG' },
  { id: 'sol',  address: 'GURgJGXeFfbV9S4Kr1xgxCrS367w3gkCuuS8up7xiDEG' },
  { id: 'bnb',  address: '0x54B1db8e055F71ba5A6CeB3EFfc88D4cbB315935' },
  { id: 'ton',  address: 'UQBbbIS1-F3ufPBPD13EKfp28G_A_j10kXNn-XuuxQUwoIEs' },
];

const QR_SIZE = 400;
const LOGO_PCT = 0.20;
const LOGO_SIZE = Math.round(QR_SIZE * LOGO_PCT);
const PAD = 10;

async function generate(chain) {
  const qrBuf = await QRCode.toBuffer(chain.address, {
    errorCorrectionLevel: 'H',
    width: QR_SIZE,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const logoBuf = await sharp(path.join(OUT_DIR, `${chain.id}-logo-temp.png`))
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain' })
    .toBuffer();

  const padBox = LOGO_SIZE + PAD * 2;
  const padBg = await sharp({
    create: {
      width: padBox,
      height: padBox,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const padTop = Math.round((QR_SIZE - padBox) / 2);
  const logoTop = Math.round((QR_SIZE - LOGO_SIZE) / 2);

  const outFile = path.join(OUT_DIR, `${chain.id}-qr.png`);
  await sharp(qrBuf)
    .composite([
      { input: padBg, top: padTop, left: padTop },
      { input: logoBuf, top: logoTop, left: logoTop },
    ])
    .png()
    .toFile(outFile);

  console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)`);
}

async function main() {
  for (const c of CHAINS) await generate(c);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
