# Kash — Accept Bitcoin Cash

A naira-first, non-custodial point-of-sale for Bitcoin Cash. Merchants type a
naira amount, show a BIP21 QR / "Pay with wallet" link, and get a live PAID
confirmation the moment the payment hits the chain — then share a clean receipt
on WhatsApp and cash out to naira.

Non-custodial: funds never pass through this app. It only reads the chain and
builds payment requests.

## Run locally
```bash
npm install
npm run dev
```

## Build for production
```bash
npm run build      # outputs to dist/
npm run preview    # preview the production build
```

## Before taking real payments
1. Open settings (gear icon) and paste your own BCH receiving address.
2. In `src/App.jsx`, set `DEMO_FALLBACK = false` to rely solely on live detection.
3. Calibrate the Watchtower message parse against one real message from
   `wss://watchtower.cash` (field names noted in `src/bch.js`).

## Tech
React + Vite. BCH helpers in `src/bch.js` use `qrcode` and `@bitauth/libauth`,
with live payment detection via the Watchtower hosted indexer.
