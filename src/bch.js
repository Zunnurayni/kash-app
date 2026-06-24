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
// Opens a websocket scoped to one receiving address. Watchtower pushes a
// message the instant a transaction paying that address is seen (0-conf).
//
// Usage:
//   const stop = watchAddress(address, {
//     expectedBch: 0.0012,
//     onPaid: (info) => { ... flip to PAID ... },
//     onStatus: (s) => { ... "connecting" | "live" | "error" ... },
//   });
//   // later: stop();   // closes socket + cancels reconnect
//
// Returns a cleanup function.
export function watchAddress(address, {
  expectedBch = null,
  confirmations = 0,       // 0 = accept on first mempool sighting (instant)
  onPaid = () => {},
  onStatus = () => {},
  host = "watchtower.cash",
  tolerance = 1e-8,
} = {}) {
  const addr = address.replace("bitcoincash:", "");
  const url = `wss://${host}/ws/watch/bch/${addr}/`;

  let ws = null;
  let reconnectTimer = null;
  let stopped = false;

  function open() {
    if (stopped) return;
    onStatus("connecting");
    ws = new WebSocket(url);

    ws.onopen = () => onStatus("live");

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      // ── Watchtower message normalisation ───────────────────────────────────
      // The live server's payload shape can vary by event. We read the common
      // fields defensively. CALIBRATION NOTE: log one real message from the live
      // server and tighten these field names to match exactly.
      const rawValue =
        msg?.value ?? msg?.amount ?? msg?.tx?.value ?? msg?.token?.amount ?? null;

      // value may arrive in sats (integer, large) or BCH (decimal). Heuristic:
      // anything >= 100000 we treat as sats. Safer: rely on a known field name
      // once calibrated (e.g. msg.value_sats).
      let bchPaid = null;
      if (typeof rawValue === "number") {
        bchPaid = rawValue >= 1e5 ? rawValue / 1e8 : rawValue;
      }

      const confs = msg?.confirmations ?? msg?.conf ?? 0;
      const meetsConf = confs >= confirmations;

      const meetsAmount =
        expectedBch == null || bchPaid == null
          ? true
          : bchPaid + tolerance >= expectedBch;

      if (meetsConf && meetsAmount) {
        onPaid({
          txid: msg?.txid || msg?.tx?.hash || null,
          bch: bchPaid,
          confirmations: confs,
          raw: msg,
        });
      }
    };

    ws.onerror = () => onStatus("error");

    ws.onclose = () => {
      if (stopped) return;
      onStatus("error");
      reconnectTimer = setTimeout(open, 2500); // auto-reconnect while waiting
    };
  }

  open();

  return function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
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
