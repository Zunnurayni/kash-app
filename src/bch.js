// ── bch.js · Kash production utilities ───────────────────────────────────────
// Real, deployable helpers for the Kash merchant checkout. Import these in a
// normal browser / Capacitor / Vite build:
//
//   import { validateAddress, buildPayUri, qrSvg, watchAddress } from "./bch.js";
//
// Dependencies (add to package.json):
//   npm i qrcode @bitauth/libauth
//
// Everything here is non-custodial: we only ever READ the chain and BUILD
// payment requests. No private keys, no fund movement.

import QRCode from "qrcode";
import { decodeCashAddress } from "@bitauth/libauth";

// ── 1. Address validation (libauth) ──────────────────────────────────────────
// decodeCashAddress returns { payload, prefix, type } on success, or a STRING
// error message on failure. We normalise that into a simple boolean + reason.
export function validateAddress(address) {
  if (!address || typeof address !== "string") {
    return { valid: false, reason: "No address provided" };
  }
  // decodeCashAddress requires the "bitcoincash:" prefix, so add it if missing.
  const prefixed = address.includes(":") ? address : `bitcoincash:${address}`;
  const result = decodeCashAddress(prefixed);
  if (typeof result === "string") {
    return { valid: false, reason: result };
  }
  // Only accept mainnet receiving addresses.
  if (result.prefix !== "bitcoincash") {
    return { valid: false, reason: `Not a mainnet BCH address (prefix: ${result.prefix})` };
  }
  return { valid: true, prefix: result.prefix, type: result.type };
}

// ── 2. BIP21 payment URI ─────────────────────────────────────────────────────
// Produces e.g. bitcoincash:qxy...?amount=0.00123456&label=Mama%20Ngozi
// amount MUST be in whole BCH with up to 8 decimals (BIP21 rule).
export function buildPayUri({ address, bch, label, message }) {
  const base = address.startsWith("bitcoincash:") ? address : `bitcoincash:${address}`;
  const params = new URLSearchParams();
  if (bch != null) params.set("amount", Number(bch).toFixed(8));
  if (label) params.set("label", label);
  if (message) params.set("message", message);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ── 3. QR code as inline SVG (no external API, works offline) ─────────────────
// Returns a Promise<string> of SVG markup you can inject with innerHTML or a
// React dangerouslySetInnerHTML. Black-on-white, no margin, high error
// correction so it survives a cracked phone screen in a market.
export function qrSvg(text, { width = 220 } = {}) {
  return QRCode.toString(text, {
    type: "svg",
    margin: 0,
    width,
    errorCorrectionLevel: "M",
    color: { dark: "#11150F", light: "#ffffff" },
  });
}

// ── 4. Live payment detection (Watchtower hosted indexer) ────────────────────
// Two detectors run together for speed AND reliability:
//   1. UTXO POLLING (primary)  — every few seconds, ask Watchtower for the
//      address's unspent outputs and check if one matches the expected amount.
//      Reliable: doesn't depend on a push arriving, survives a dropped socket.
//      (We poll UTXOs, not /balance/, because balance is cached ~5 min on
//      mainnet — confirmed by reading Watchtower's source.)
//   2. WEBSOCKET (instant)     — wss .../ws/watch/address/<addr>/ pushes a
//      message the moment a tx is seen. The live payload is:
//        { token:"bch", txid, recipient, value:<satoshis int>, decimals:8 }
//      We use the NON-deprecated /address/ path (the /bch/ path is legacy).
//
// Whichever fires first wins; we de-dupe so onPaid runs once.
//
// Usage:
//   const stop = watchAddress(address, {
//     expectedBch, onPaid: (info) => {...}, onStatus: (s) => {...},
//   });
//   // later: stop();
//
// Returns a cleanup function.
export function watchAddress(address, {
  expectedBch = null,
  onPaid = () => {},
  onStatus = () => {},
  host = "watchtower.cash",
  pollMs = 3000,
  tolerance = 1e-8,
} = {}) {
  const full = address.startsWith("bitcoincash:") ? address : `bitcoincash:${address}`;
  const bare = full.replace("bitcoincash:", "");

  let ws = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let stopped = false;
  let done = false;

  const expectedSats = expectedBch != null ? Math.round(expectedBch * 1e8) : null;

  function finish(info) {
    if (done) return;
    done = true;
    cleanup();
    onPaid(info);
  }

  // ── detector 1: UTXO polling ───────────────────────────────────────────────
  async function poll() {
    if (stopped || done) return;
    try {
      const res = await fetch(`https://${host}/api/utxo/bch/${bare}/`);
      if (res.ok) {
        const json = await res.json();
        const utxos = json?.utxos || json?.data || (Array.isArray(json) ? json : []);
        // Each utxo carries a satoshi value. Accept when any single utxo (or the
        // sum of new ones) covers the expected amount. Simple + robust: match a
        // utxo whose value >= expected (merchant invoices are exact-amount).
        let hit = null;
        for (const u of utxos) {
          const v = Number(u.value ?? u.amount ?? u.value_satoshis ?? 0);
          if (expectedSats == null || v + 1 >= expectedSats) { hit = { v, u }; break; }
        }
        if (hit) {
          finish({
            txid: hit.u.txid || hit.u.tx_hash || null,
            bch: hit.v / 1e8,
            via: "poll",
          });
          return;
        }
      }
    } catch (_) { /* network hiccup — keep polling */ }
    pollTimer = setTimeout(poll, pollMs);
  }

  // ── detector 2: websocket (instant) ────────────────────────────────────────
  function openSocket() {
    if (stopped || done) return;
    try {
      onStatus("connecting");
      ws = new WebSocket(`wss://${host}/ws/watch/address/${bare}/`);
      ws.onopen = () => onStatus("live");
      ws.onmessage = (event) => {
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        // Real payload: value is in satoshis (integer), token === "bch".
        if (msg?.token && msg.token !== "bch") return; // ignore token txs
        const sats = Number(msg?.value ?? 0);
        const bchPaid = sats / 1e8;
        const ok = expectedSats == null || sats + 1 >= expectedSats;
        if (ok) finish({ txid: msg?.txid || null, bch: bchPaid, via: "ws" });
      };
      ws.onerror = () => onStatus("error");
      ws.onclose = () => {
        if (stopped || done) return;
        onStatus("error");
        reconnectTimer = setTimeout(openSocket, 2500);
      };
    } catch { onStatus("error"); }
  }

  function cleanup() {
    clearTimeout(reconnectTimer);
    clearTimeout(pollTimer);
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  }

  // start both
  openSocket();
  poll();

  return function stop() {
    stopped = true;
    cleanup();
    onStatus("idle");
  };
}

// ── 5. REST balance check (backstop / reconciliation) ────────────────────────
// Watchtower also exposes a REST endpoint. Use this to confirm a payment if the
// websocket missed it, or to reconcile a charge after the fact.
export async function addressInfo(address, { host = "watchtower.cash" } = {}) {
  const addr = address.replace("bitcoincash:", "");
  const res = await fetch(`https://${host}/api/address-info/bch/${addr}/`);
  if (!res.ok) throw new Error(`Watchtower ${res.status}`);
  return res.json();
}
