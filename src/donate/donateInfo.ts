// src/donate/donateInfo.ts
//
// SINGLE SOURCE OF TRUTH for donate / "Send me a Bánh Mì" content.
//
// Everything that shows donate info derives from here:
//   - the Donate webview (banh-mi animation) — src/webviews/DonatePanel.ts
//   - the README "Send me a Bánh Mì" section — enforced by
//     src/donate/donateInfo.test.ts (drift test): if an address/message here
//     changes, the test fails until README is updated to match.
//
// So updating an address or message in ONE place (here) flags every other
// donate surface that drifted. Crypto addresses are money-critical — they were
// decoded from the source wallet QR (see .adn/lessons.md 2026-05-19); do not
// hand-edit them by eye.

export interface DonateChain {
  /** stable id, also the QR filename stem under images/donate/<id>-qr.png */
  id: string;
  /** display name of the network */
  network: string;
  /** coins accepted, e.g. 'SOL · USDT · USDC' */
  coins: string;
  /** chain wording, e.g. 'Solana chain' */
  chain: string;
  /** small note, e.g. '(any SPL token accepted)' */
  note: string;
  /** the wallet address */
  address: string;
  /** QR image filename under images/donate/ */
  qrFile: string;
}

export interface DonateInfo {
  /** headline, e.g. 'Send me a Bánh Mì' */
  title: string;
  /** one-line pitch */
  subtitle: string;
  chains: DonateChain[];
  /** short safety tips shown under the addresses */
  tips: string[];
  /** footer line */
  footer: string;
}

export const DONATE: DonateInfo = {
  title: 'Send me a Bánh Mì',
  subtitle: 'If this extension saved you time, you could send me a Vietnamese sandwich! 🇻🇳',
  chains: [
    {
      id: 'sol',
      network: 'Solana',
      coins: 'SOL · USDT · USDC',
      chain: 'Solana chain',
      note: '(any SPL token accepted)',
      address: 'GURgJGXeFfbV9S4Kr1xgxCrS367w3gkCuuS8up7xiDEG',
      qrFile: 'sol-qr.png',
    },
    {
      id: 'ton',
      network: 'The Open Network',
      coins: 'TON · USDT',
      chain: 'The Open Network chain',
      note: '(any Jetton accepted)',
      address: 'UQBbblS1-F3ufPBPD13EKfp28G_A_j10kXNn-XuuxQUwoIEs',
      qrFile: 'ton-qr.png',
    },
  ],
  tips: [
    'No memo / tag required for either chain — just send the coin to the address.',
    'Send only the matching coin on its matching chain — wrong coin / wrong chain = lost funds',
  ],
  footer: 'Made with cà phê sữa đá in Vietnam 🍜',
};
