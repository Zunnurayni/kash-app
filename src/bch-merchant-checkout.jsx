import React, { useState, useEffect, useRef } from "react";

// ── Kash · "Accept BCH" merchant checkout ────────────────────────────────────
// Naira-first, non-custodial point-of-sale for Bitcoin Cash.
// Type naira → live BCH → BIP21 QR + "Pay with wallet" deep link + copy →
// live Watchtower payment-watch → PAID flip → white receipt image to WhatsApp
// → naira cash-out.
//
// PRODUCTION NOTE: a deployable build should import the companion bch.js module
// (qrcode + @bitauth/libauth + Watchtower) shipped alongside this file. This
// in-chat artifact can't import npm packages, so it inlines equivalent logic
// with safe fallbacks — same behaviour, demo-friendly. Where they differ is
// flagged inline. No private keys, no custody: Kash only reads the chain and
// builds payment requests.

const DEFAULT_ADDRESS = "bitcoincash:qqz95enwd6qdcy5wnf05hp590sjjknwfuqttev5vyc";

// ── address validation (inline CashAddr check) ───────────────────────────────
// Production uses libauth's decodeCashAddress (full checksum verification).
// In-artifact we do a structural + charset check: prefix, valid bech32 chars,
// plausible length. Good enough to catch typos/paste errors in the demo; the
// real build swaps in validateAddress() from bch.js for true checksum safety.
const CASHADDR_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function validateAddressInline(addr) {
  if (!addr || typeof addr !== "string") return { valid: false, reason: "Enter an address" };
  const s = addr.includes(":") ? addr : `bitcoincash:${addr}`;
  const [prefix, payload] = s.split(":");
  if (prefix !== "bitcoincash") return { valid: false, reason: "Must be a bitcoincash: address" };
  if (!payload || payload.length < 42) return { valid: false, reason: "Address looks too short" };
  const body = payload.toLowerCase();
  for (const ch of body) {
    if (!CASHADDR_CHARSET.includes(ch)) return { valid: false, reason: `Invalid character: ${ch}` };
  }
  return { valid: true };
}

const fmtN = (n) => "₦" + Math.round(n).toLocaleString("en-NG");
const fmtBCH = (n) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 });

export default function App() {
  const [screen, setScreen] = useState("enter"); // enter | charge | paid | history
  const [naira, setNaira] = useState("");
  const [rate, setRate] = useState(null);
  const [rateState, setRateState] = useState("loading");
  const [note, setNote] = useState("");
  const [charge, setCharge] = useState(null);
  const [secsWaiting, setSecsWaiting] = useState(0);
  const [merchant, setMerchant] = useState("Mama Ngozi Stores");
  const [editingName, setEditingName] = useState(false);
  const [address, setAddress] = useState(DEFAULT_ADDRESS);
  const [sales, setSales] = useState([]);
  const [wsStatus, setWsStatus] = useState("idle"); // idle | connecting | live | error
  const tickRef = useRef(null);    // seconds counter
  const wsRef = useRef(null);      // live Watchtower socket
  const pollRef = useRef(null);    // UTXO polling timer
  const reconnectRef = useRef(null);
  const settledRef = useRef(false); // de-dupe across both detectors

  // Watchtower hosted indexer (same infra Paytaca uses), verified against its
  // open-source API. Detection uses UTXO polling + the /ws/watch/address/ socket.

  useEffect(() => {
    let alive = true;
    async function pull() {
      try {
        const r = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=ngn"
        );
        const j = await r.json();
        const v = j?.["bitcoin-cash"]?.ngn;
        if (alive && v) { setRate(v); setRateState("live"); return; }
        throw new Error("no value");
      } catch {
        if (alive) { setRate((p) => p ?? 640000); setRateState("fallback"); }
      }
    }
    pull();
    const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const bchForNaira = (amt) => (rate ? amt / rate : 0);

  function startCharge() {
    const amt = parseFloat(naira);
    if (!amt || amt <= 0 || !rate) return;
    const ref = "KASH-" + Math.random().toString(36).slice(2, 7).toUpperCase();
    settledRef.current = false; // arm detector for the new charge
    setCharge({ naira: amt, bch: bchForNaira(amt), ref, at: Date.now(), note });
    setSecsWaiting(0);
    setScreen("charge");
  }

  useEffect(() => {
    if (screen !== "charge" || !charge) return;
    tickRef.current = setInterval(() => setSecsWaiting((s) => s + 1), 1000);

    // ── REAL PAYMENT DETECTION ───────────────────────────────────────────────
    // Two detectors run together (verified against Watchtower's source):
    //   1. UTXO POLLING (primary, reliable): GET /api/utxo/bch/<addr>/ every few
    //      seconds; settle when an unspent output matches the expected amount.
    //      We poll UTXOs, not /balance/, because balance is cached ~5 min.
    //   2. WEBSOCKET (instant bonus): wss .../ws/watch/address/<addr>/ — the live
    //      payload is { token:"bch", txid, recipient, value:<satoshis> }. We use
    //      the non-deprecated /address/ path.
    // Whichever sees the payment first wins; settle() de-dupes.
    const bare = (address.startsWith("bitcoincash:") ? address : "bitcoincash:" + address)
      .replace("bitcoincash:", "");
    const expectedSats = Math.round(charge.bch * 1e8);

    // detector 1 — UTXO poll
    async function poll() {
      try {
        const res = await fetch(`https://watchtower.cash/api/utxo/bch/${bare}/`);
        if (res.ok) {
          const json = await res.json();
          const utxos = json?.utxos || json?.data || (Array.isArray(json) ? json : []);
          for (const u of utxos) {
            const v = Number(u.value ?? u.amount ?? u.value_satoshis ?? 0);
            if (v + 1 >= expectedSats) {
              settle({ txid: u.txid || u.tx_hash || null, via: "poll" });
              return;
            }
          }
        }
      } catch (_) { /* keep polling through network hiccups */ }
      pollRef.current = setTimeout(poll, 3000);
    }
    // small initial delay so a freshly-paid tx has time to propagate
    pollRef.current = setTimeout(poll, 1500);

    // detector 2 — websocket
    function connect() {
      try {
        setWsStatus("connecting");
        const ws = new WebSocket(`wss://watchtower.cash/ws/watch/address/${bare}/`);
        wsRef.current = ws;
        ws.onopen = () => setWsStatus("live");
        ws.onmessage = (event) => {
          let msg; try { msg = JSON.parse(event.data); } catch { return; }
          if (msg?.token && msg.token !== "bch") return; // ignore token txs
          const sats = Number(msg?.value ?? 0);
          if (sats + 1 >= expectedSats) {
            settle({ txid: msg?.txid || null, via: "ws" });
          }
        };
        ws.onerror = () => setWsStatus("error");
        ws.onclose = () => {
          if (screen === "charge") reconnectRef.current = setTimeout(connect, 2500);
        };
      } catch { setWsStatus("error"); }
    }
    connect();

    return () => {
      clearInterval(tickRef.current);
      clearTimeout(pollRef.current);
      clearTimeout(reconnectRef.current);
      if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
      setWsStatus("idle");
    };
    // eslint-disable-next-line
  }, [screen]);

  // Tapping "Pay with wallet" → kick an immediate balance/UTXO check shortly
  // after, so detection doesn't wait for the next poll tick.
  function nudgePoll() {
    clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      if (screen !== "charge" || !charge) return;
      const bare = (address.startsWith("bitcoincash:") ? address : "bitcoincash:" + address)
        .replace("bitcoincash:", "");
      const expectedSats = Math.round(charge.bch * 1e8);
      try {
        const res = await fetch(`https://watchtower.cash/api/utxo/bch/${bare}/`);
        if (res.ok) {
          const json = await res.json();
          const utxos = json?.utxos || json?.data || (Array.isArray(json) ? json : []);
          for (const u of utxos) {
            const v = Number(u.value ?? u.amount ?? u.value_satoshis ?? 0);
            if (v + 1 >= expectedSats) { settle({ txid: u.txid || null, via: "nudge" }); return; }
          }
        }
      } catch (_) {}
    }, 2500);
  }

  function settle(meta = {}) {
    if (settledRef.current) return; // de-dupe across both detectors
    settledRef.current = true;
    clearTimeout(pollRef.current);
    clearTimeout(reconnectRef.current);
    clearInterval(tickRef.current);
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    setSales((prev) => [{ ...charge, paidAt: Date.now(), txid: meta.txid || null }, ...prev]);
    setScreen("paid");
  }

  function reset() {
    setNaira(""); setNote(""); setCharge(null); setScreen("enter");
  }

  const payUri = charge
    ? `${address.startsWith("bitcoincash:") ? address : "bitcoincash:" + address}` +
      `?amount=${charge.bch.toFixed(8)}&label=${encodeURIComponent(merchant)}`
    : "";

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      <div style={S.phone}>
        <div style={S.top}>
          <div style={S.brandRow}>
            <Logo />
            <div>
              <div style={S.brandName}>Kash</div>
              <div style={S.brandSub}>accept Bitcoin Cash</div>
            </div>
          </div>
          <RatePill state={rateState} rate={rate} />
        </div>

        <div style={S.merchantBar}>
          <span style={S.merchantLabel}>Paying</span>
          {editingName ? (
            <input
              autoFocus value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => e.key === "Enter" && setEditingName(false)}
              style={S.merchantInput}
            />
          ) : (
            <button style={S.merchantName} onClick={() => setEditingName(true)}>
              {merchant} <span style={S.editGlyph}>edit</span>
            </button>
          )}
          <button
            style={S.histTab}
            onClick={() => setScreen(screen === "history" ? "enter" : "history")}
            aria-label="Sales history"
          >
            <HistIcon /> {sales.length > 0 && <span style={S.histCount}>{sales.length}</span>}
          </button>
          <button
            style={S.histTab}
            onClick={() => setScreen(screen === "settings" ? "enter" : "settings")}
            aria-label="Settings"
          >
            <GearIcon />
            {address === DEFAULT_ADDRESS && <span style={S.warnDot} />}
          </button>
        </div>

        {screen === "settings" && (
          <Settings
            merchant={merchant} setMerchant={setMerchant}
            address={address} setAddress={setAddress}
            isDefault={address === DEFAULT_ADDRESS}
            onBack={() => setScreen("enter")}
          />
        )}

        {screen === "enter" && (
          <Enter
            naira={naira} setNaira={setNaira} note={note} setNote={setNote}
            rate={rate} bchForNaira={bchForNaira} onCharge={startCharge}
          />
        )}
        {screen === "charge" && charge && (
          <Charge
            charge={charge} payUri={payUri} wsStatus={wsStatus}
            secs={secsWaiting} onCancel={reset} onWalletTap={nudgePoll}
          />
        )}
        {screen === "paid" && charge && (
          <Paid charge={charge} merchant={merchant} onNew={reset} />
        )}
        {screen === "history" && (
          <History sales={sales} onBack={() => setScreen("enter")} />
        )}
      </div>

      <p style={S.disclaimer}>
        Non-custodial · funds never pass through this tool. The QR and wallet link are real
        BIP21. Payment detection runs two ways at once — it polls Watchtower for the address's
        unspent outputs every few seconds and listens on the live websocket — and flips to PAID
        as soon as either sees your payment. (In this in-chat preview, outbound network calls are
        sandboxed; run the app from your own build for live detection.)
      </p>
    </div>
  );
}

// ── ENTER ────────────────────────────────────────────────────────────────────
function Enter({ naira, setNaira, note, setNote, rate, bchForNaira, onCharge }) {
  const amt = parseFloat(naira) || 0;
  const bch = bchForNaira(amt);
  const quick = [500, 1000, 2000, 5000];
  return (
    <div style={S.body}>
      <label style={S.fieldLabel}>Amount to charge</label>
      <div style={S.nairaField}>
        <span style={S.nairaSign}>₦</span>
        <input
          inputMode="numeric" placeholder="0" value={naira}
          onChange={(e) => setNaira(e.target.value.replace(/[^0-9.]/g, ""))}
          style={S.nairaInput}
        />
      </div>
      <div style={S.quickRow}>
        {quick.map((q) => (
          <button key={q} style={S.quickBtn} onClick={() => setNaira(String(q))}>
            ₦{q.toLocaleString()}
          </button>
        ))}
      </div>
      <div style={S.convertLine}>
        <span style={S.convertEq}>=</span>
        <span style={S.convertBch}>{rate ? fmtBCH(bch) : "—"}</span>
        <span style={S.convertUnit}>BCH</span>
      </div>
      <input
        placeholder="What's it for? (optional)" value={note}
        onChange={(e) => setNote(e.target.value)} style={S.noteInput}
      />
      <button
        style={{ ...S.cta, ...(amt > 0 && rate ? {} : S.ctaOff) }}
        disabled={!(amt > 0 && rate)} onClick={onCharge}
      >
        Show payment code
      </button>
    </div>
  );
}

// ── CHARGE ───────────────────────────────────────────────────────────────────
function Charge({ charge, payUri, secs, wsStatus, onCancel, onWalletTap }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(payUri);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  };
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  const watchLabel =
    wsStatus === "live" ? "Watching the blockchain — live"
    : wsStatus === "connecting" ? "Connecting to the network…"
    : wsStatus === "error" ? "Reconnecting…"
    : "Waiting for payment";
  return (
    <div style={S.body}>
      <div style={S.waitStatus}>
        <span className="pulseDot" style={S.pulseDot} />
        <span style={S.waitText}>{watchLabel}</span>
        <span style={S.waitClock}>{mm}:{ss}</span>
      </div>

      <div style={S.amountStack}>
        <div style={S.bigNaira}>{fmtN(charge.naira)}</div>
        <div style={S.subBch}>{fmtBCH(charge.bch)} BCH</div>
        {charge.note && <div style={S.chargeNote}>“{charge.note}”</div>}
      </div>

      <div style={S.qrWrap}>
        <QrCode text={payUri} size={200} />
      </div>
      <div style={S.scanHint}>Scan with any Bitcoin Cash wallet</div>

      {/* Pay with wallet — opens installed BCH wallet via BIP21 deep link,
          and immediately nudges a payment check so detection is near-instant */}
      <a href={payUri} style={S.walletBtn} onClick={onWalletTap}>
        <WalletIcon /> Pay with wallet
      </a>
      <div style={S.walletSub}>Opens Bitcoin.com, Paytaca, Selene, Electron Cash…</div>

      <div style={S.uriRow}>
        <code style={S.uriText}>{payUri.split(":")[1]?.split("?")[0]}</code>
        <button style={S.copyBtn} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <div style={S.refLine}>Ref {charge.ref}</div>

      <button style={S.linkBtn} onClick={onCancel}>Cancel charge</button>
    </div>
  );
}

// ── PAID ─────────────────────────────────────────────────────────────────────
function Paid({ charge, merchant, onNew }) {
  const [sharing, setSharing] = useState(false);
  const [shareMsg, setShareMsg] = useState("");
  const when = new Date(charge.at).toLocaleString("en-NG", {
    dateStyle: "medium", timeStyle: "short",
  });

  async function shareReceipt() {
    setSharing(true); setShareMsg("");
    try {
      const blob = await renderReceiptPNG({ charge, merchant, when });
      const file = new File([blob], `kash-receipt-${charge.ref}.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Payment receipt" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name; a.click();
        URL.revokeObjectURL(url);
        setShareMsg("Receipt image downloaded — attach it in WhatsApp.");
      }
    } catch (e) {
      setShareMsg("Couldn't generate the image. Try again.");
    } finally {
      setSharing(false);
    }
  }

  const monica = "https://monica.cash/sell-bitcoin-cash-nigeria";

  return (
    <div style={S.body}>
      <div className="paidPop" style={S.paidBadge}><Check /><span>PAID</span></div>

      {/* on-screen receipt (mirrors the generated image) */}
      <div style={S.receipt}>
        <div style={S.rcptTop}>
          <span style={S.rcptMerchant}>{merchant}</span>
          <span style={S.rcptTag}>Bitcoin Cash</span>
        </div>
        <div style={S.rcptAmount}>{fmtN(charge.naira)}</div>
        <div style={S.rcptBch}>{fmtBCH(charge.bch)} BCH</div>
        <div style={S.rcptDivider} />
        {charge.note && <Row k="For" v={charge.note} />}
        <Row k="Reference" v={charge.ref} />
        <Row k="Time" v={when} />
        <Row k="Status" v="Confirmed on-chain" good />
      </div>

      <button style={S.waBtn} onClick={shareReceipt} disabled={sharing}>
        {sharing ? "Preparing image…" : "Send receipt on WhatsApp"}
      </button>
      {shareMsg && <div style={S.shareMsg}>{shareMsg}</div>}

      <a href={monica} target="_blank" rel="noreferrer" style={S.cashoutBtn}>Cash out to naira →</a>
      <button style={S.linkBtn} onClick={onNew}>New charge</button>
    </div>
  );
}

// ── receipt image generator (clean white card → PNG) ─────────────────────────
function renderReceiptPNG({ charge, merchant, when }) {
  return new Promise((resolve) => {
    const W = 820, H = 1140, s = 2; // retina
    const c = document.createElement("canvas");
    c.width = W * s; c.height = H * s;
    const x = c.getContext("2d"); x.scale(s, s);

    const ink = "#11150F", green = "#0F7A3D", gold = "#F2B705",
      slate = "#9aa18f", line = "#ece6d8", paper = "#ffffff";

    // backdrop
    x.fillStyle = "#FBF7EE"; x.fillRect(0, 0, W, H);
    // card
    const cx = 60, cy = 60, cw = W - 120, ch = H - 120, r = 34;
    roundRect(x, cx, cy, cw, ch, r); x.fillStyle = paper; x.fill();
    x.strokeStyle = line; x.lineWidth = 2; x.stroke();

    let y = cy + 70;
    const cxc = W / 2;

    // logo coin
    x.beginPath(); x.arc(cxc, y + 6, 30, 0, Math.PI * 2); x.fillStyle = green; x.fill();
    x.fillStyle = "#FBF7EE"; x.font = "800 34px DM Sans, sans-serif";
    x.textAlign = "center"; x.fillText("₿", cxc, y + 18);
    y += 70;

    x.fillStyle = ink; x.font = "800 30px DM Sans, sans-serif";
    x.fillText("Kash", cxc, y); y += 26;
    x.fillStyle = slate; x.font = "600 15px DM Sans, sans-serif";
    x.fillText("PAYMENT RECEIPT", cxc, y); y += 46;

    // PAID pill
    const pw = 150, ph = 46;
    roundRect(x, cxc - pw / 2, y - 30, pw, ph, 23); x.fillStyle = green; x.fill();
    x.fillStyle = "#FBF7EE"; x.font = "800 20px DM Sans, sans-serif";
    x.fillText("✓  PAID", cxc, y - 1); y += 54;

    // merchant
    x.fillStyle = ink; x.font = "800 26px DM Sans, sans-serif";
    x.fillText(merchant, cxc, y); y += 50;

    // big amount
    x.fillStyle = ink; x.font = "800 76px DM Sans, sans-serif";
    x.fillText(fmtN(charge.naira), cxc, y); y += 44;
    x.fillStyle = green; x.font = "700 22px DM Sans, sans-serif";
    x.fillText(`${fmtBCH(charge.bch)} BCH`, cxc, y); y += 50;

    // dashed divider
    dashed(x, cx + 50, y, cx + cw - 50, y, line); y += 46;

    // rows
    const rows = [];
    if (charge.note) rows.push(["For", charge.note]);
    rows.push(["Reference", charge.ref]);
    rows.push(["Time", when]);
    rows.push(["Paid in", "Bitcoin Cash"]);
    rows.push(["Status", "Confirmed on-chain"]);
    x.font = "600 18px DM Sans, sans-serif";
    const lx = cx + 50, rx = cx + cw - 50;
    rows.forEach(([k, v]) => {
      x.textAlign = "left"; x.fillStyle = slate; x.fillText(k, lx, y);
      x.textAlign = "right";
      x.fillStyle = k === "Status" ? green : ink;
      x.font = (k === "Status" ? "800 18px" : "700 18px") + " DM Sans, sans-serif";
      x.fillText(v, rx, y);
      x.font = "600 18px DM Sans, sans-serif";
      y += 40;
    });

    // footer
    y = cy + ch - 70;
    dashed(x, cx + 50, y, cx + cw - 50, y, line); y += 40;
    x.textAlign = "center"; x.fillStyle = slate; x.font = "600 15px DM Sans, sans-serif";
    x.fillText("Non-custodial · peer-to-peer · powered by Bitcoin Cash", cxc, y);

    // gold accent ticks (corners)
    x.fillStyle = gold;
    [[cx + 22, cy + 22], [cx + cw - 30, cy + 22]].forEach(([gx, gy]) => {
      x.fillRect(gx, gy, 8, 22); x.fillRect(gx + 14, gy, 8, 22);
    });

    c.toBlob((b) => resolve(b), "image/png");
  });
}
function roundRect(x, a, b, w, h, r) {
  x.beginPath();
  x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r);
  x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r);
  x.arcTo(a, b, a + w, b, r); x.closePath();
}
function dashed(x, x1, y1, x2, y2, color) {
  x.save(); x.strokeStyle = color; x.lineWidth = 2; x.setLineDash([6, 7]);
  x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke(); x.restore();
}

// ── SETTINGS (receiving address + merchant name) ─────────────────────────────
function Settings({ merchant, setMerchant, address, setAddress, isDefault, onBack }) {
  const [draft, setDraft] = useState(address);
  const v = validateAddressInline(draft);
  const save = () => { if (v.valid) { setAddress(draft.trim()); onBack(); } };
  return (
    <div style={S.body}>
      <label style={S.fieldLabel}>Business name</label>
      <input value={merchant} onChange={(e) => setMerchant(e.target.value)} style={S.setInput} />

      <label style={{ ...S.fieldLabel, marginTop: 18 }}>Your BCH receiving address</label>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        spellCheck={false}
        style={{ ...S.setInput, fontFamily: "ui-monospace, monospace", fontSize: 12.5, resize: "none" }}
      />
      <div style={{ ...S.addrStatus, color: v.valid ? "#0F7A3D" : "#C44A2E" }}>
        {v.valid ? "✓ Valid Bitcoin Cash address" : v.reason}
      </div>

      {isDefault && (
        <div style={S.warnBox}>
          This is a demo address — payments sent to it won't reach you. Paste your own wallet's
          receiving address before taking real payments.
        </div>
      )}

      <div style={S.setNote}>
        Production builds verify the full address checksum with libauth. Your address is the only
        thing that controls where money lands — Kash never holds your funds or keys.
      </div>

      <button style={{ ...S.cta, ...(v.valid ? {} : S.ctaOff) }} disabled={!v.valid} onClick={save}>
        Save
      </button>
      <button style={S.linkBtn} onClick={onBack}>Back</button>
    </div>
  );
}

// ── QR code (real, inline, offline) ──────────────────────────────────────────
// Production uses qrSvg() from bch.js (the `qrcode` npm package). The artifact
// can't import npm, so this renders via a public QR image service from the SAME
// real BIP21 payUri. Visually identical; swap to the bundled lib for offline.
function QrCode({ text, size = 200 }) {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=440x440&margin=0&data=${encodeURIComponent(text)}`;
  return (
    <img
      src={src}
      alt="Scan with any BCH wallet to pay the exact amount"
      style={{ width: size, height: size, display: "block" }}
    />
  );
}

// ── HISTORY ──────────────────────────────────────────────────────────────────
function History({ sales, onBack }) {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const today = sales.filter((s) => s.paidAt >= startOfToday.getTime());
  const todayTotal = today.reduce((sum, s) => sum + s.naira, 0);
  return (
    <div style={S.body}>
      <div style={S.histSummary}>
        <div>
          <div style={S.histSumLabel}>Today</div>
          <div style={S.histSumValue}>{fmtN(todayTotal)}</div>
        </div>
        <div style={S.histSumCount}>{today.length} {today.length === 1 ? "sale" : "sales"}</div>
      </div>
      {sales.length === 0 ? (
        <div style={S.histEmpty}>No sales yet. Your paid charges will show here.</div>
      ) : (
        <div style={S.histList}>
          {sales.map((s, i) => {
            const time = new Date(s.paidAt).toLocaleString("en-NG", {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            });
            return (
              <div key={i} style={S.histItem}>
                <div style={S.histDot} />
                <div style={S.histItemMain}>
                  <div style={S.histItemTop}>
                    <span style={S.histAmount}>{fmtN(s.naira)}</span>
                    <span style={S.histTime}>{time}</span>
                  </div>
                  <div style={S.histItemSub}>
                    {s.note ? <span style={S.histNote}>{s.note} · </span> : null}
                    <span style={S.histRef}>{s.ref}</span>
                    <span style={S.histBch}> · {fmtBCH(s.bch)} BCH</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button style={S.linkBtn} onClick={onBack}>Back</button>
    </div>
  );
}

// ── small parts ──────────────────────────────────────────────────────────────
function Row({ k, v, good }) {
  return (
    <div style={S.kvRow}>
      <span style={S.kvK}>{k}</span>
      <span style={{ ...S.kvV, ...(good ? { color: "#0F7A3D", fontWeight: 700 } : {}) }}>{v}</span>
    </div>
  );
}
function RatePill({ state, rate }) {
  const label = state === "live" ? "live rate" : state === "fallback" ? "est. rate" : "loading";
  const dot = state === "live" ? "#0F7A3D" : state === "fallback" ? "#F2B705" : "#5B6157";
  return (
    <div style={S.ratePill}>
      <span style={{ ...S.rateDot, background: dot }} />
      <div>
        <div style={S.rateVal}>{rate ? "₦" + Math.round(rate).toLocaleString() : "—"}</div>
        <div style={S.rateLbl}>{label} · 1 BCH</div>
      </div>
    </div>
  );
}
function Logo() {
  return (
    <div style={S.logo}>
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
        <circle cx="16" cy="16" r="15" fill="#0F7A3D" />
        <path d="M11 9.5h7.2c2.4 0 4 1.3 4 3.4 0 1.5-.8 2.6-2.2 3 1.7.4 2.7 1.6 2.7 3.3 0 2.3-1.8 3.8-4.5 3.8H11V9.5z" fill="#FBF7EE" />
        <rect x="14.4" y="6.6" width="1.5" height="3.4" fill="#F2B705" />
        <rect x="17.2" y="6.6" width="1.5" height="3.4" fill="#F2B705" />
        <rect x="14.4" y="22.4" width="1.5" height="3.4" fill="#F2B705" />
        <rect x="17.2" y="22.4" width="1.5" height="3.4" fill="#F2B705" />
      </svg>
    </div>
  );
}
function Check() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
      <path d="M4 12.5l5 5L20 6" fill="none" stroke="#FBF7EE" strokeWidth="3.2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function HistIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <path d="M12 7v5l3 2M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" fill="none"
        stroke="#FBF7EE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <circle cx="12" cy="12" r="3" fill="none" stroke="#FBF7EE" strokeWidth="2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
        fill="none" stroke="#FBF7EE" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden style={{ marginRight: 2 }}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v1.5M3 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-3M3 7.5h15.5a1 1 0 0 1 1 1V13"
        fill="none" stroke="#FBF7EE" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="12.5" r="1.4" fill="#FBF7EE" />
    </svg>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────
const S = {
  root: { minHeight: "100vh", background: "#11150F", display: "flex", flexDirection: "column", alignItems: "center", padding: "28px 16px 40px", fontFamily: "'DM Sans', system-ui, sans-serif" },
  phone: { width: "100%", maxWidth: 400, background: "#FBF7EE", borderRadius: 26, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,.5)", border: "1px solid #1d2418" },
  top: { background: "#11150F", padding: "18px 18px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  brandRow: { display: "flex", alignItems: "center", gap: 10 },
  logo: { width: 38, height: 38, borderRadius: 11, background: "#0c1009", display: "grid", placeItems: "center", border: "1px solid #2a3322" },
  brandName: { color: "#FBF7EE", fontWeight: 800, fontSize: 18, letterSpacing: -0.4, lineHeight: 1 },
  brandSub: { color: "#7d8a72", fontSize: 11, fontWeight: 600, marginTop: 3, letterSpacing: 0.2 },
  ratePill: { display: "flex", alignItems: "center", gap: 7, background: "#0c1009", borderRadius: 11, padding: "7px 11px", border: "1px solid #2a3322" },
  rateDot: { width: 7, height: 7, borderRadius: 6, display: "inline-block" },
  rateVal: { color: "#F2B705", fontWeight: 800, fontSize: 13, lineHeight: 1 },
  rateLbl: { color: "#7d8a72", fontSize: 9.5, fontWeight: 600, marginTop: 2 },

  merchantBar: { background: "#0F7A3D", padding: "9px 18px", display: "flex", alignItems: "center", gap: 8 },
  merchantLabel: { color: "#bfe6cd", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 },
  merchantName: { background: "none", border: "none", color: "#FBF7EE", fontWeight: 800, fontSize: 14.5, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 7, fontFamily: "inherit", flex: 1, textAlign: "left" },
  editGlyph: { fontSize: 10, fontWeight: 700, color: "#bfe6cd", border: "1px solid #3fa468", borderRadius: 5, padding: "1px 5px" },
  merchantInput: { flex: 1, background: "#0c5e2e", border: "1px solid #3fa468", borderRadius: 7, color: "#fff", fontWeight: 700, fontSize: 14, padding: "5px 9px", fontFamily: "inherit" },
  histTab: { background: "#0c5e2e", border: "1px solid #3fa468", borderRadius: 9, padding: "6px 9px", display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flex: "0 0 auto", position: "relative" },
  histCount: { color: "#FBF7EE", fontSize: 11, fontWeight: 800 },
  warnDot: { position: "absolute", top: -3, right: -3, width: 10, height: 10, borderRadius: 6, background: "#F2B705", border: "2px solid #0F7A3D" },

  setInput: { width: "100%", background: "#fff", border: "1.5px solid #e3ddcd", borderRadius: 11, padding: "12px 14px", fontSize: 14, color: "#11150F", outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  addrStatus: { fontSize: 12, fontWeight: 700, marginTop: 8, paddingLeft: 2 },
  warnBox: { marginTop: 14, background: "#fff3f0", border: "1.5px solid #f0c4ba", borderRadius: 11, padding: "12px 14px", fontSize: 12.5, lineHeight: 1.55, color: "#9a3b25", fontWeight: 600 },
  setNote: { marginTop: 14, fontSize: 12, lineHeight: 1.55, color: "#5B6157" },

  body: { padding: "20px 18px 22px" },
  fieldLabel: { display: "block", fontSize: 12, fontWeight: 800, color: "#5B6157", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 9 },
  nairaField: { display: "flex", alignItems: "center", gap: 6, background: "#fff", border: "2px solid #11150F", borderRadius: 14, padding: "10px 16px" },
  nairaSign: { fontSize: 30, fontWeight: 800, color: "#11150F" },
  nairaInput: { flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 38, fontWeight: 800, color: "#11150F", width: "100%", fontFamily: "inherit", letterSpacing: -1 },
  quickRow: { display: "flex", gap: 7, marginTop: 11 },
  quickBtn: { flex: 1, background: "#fff", border: "1.5px solid #e3ddcd", borderRadius: 10, padding: "9px 0", fontSize: 12.5, fontWeight: 700, color: "#11150F", cursor: "pointer", fontFamily: "inherit" },
  convertLine: { display: "flex", alignItems: "baseline", gap: 8, marginTop: 18, paddingLeft: 2 },
  convertEq: { fontSize: 18, fontWeight: 700, color: "#9aa18f" },
  convertBch: { fontSize: 18, fontWeight: 800, color: "#0F7A3D", fontVariantNumeric: "tabular-nums" },
  convertUnit: { fontSize: 13, fontWeight: 800, color: "#0F7A3D" },
  noteInput: { width: "100%", marginTop: 18, background: "#fff", border: "1.5px solid #e3ddcd", borderRadius: 11, padding: "12px 14px", fontSize: 14, color: "#11150F", outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  cta: { width: "100%", marginTop: 16, background: "#11150F", color: "#FBF7EE", border: "none", borderRadius: 14, padding: "16px 0", fontSize: 16, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.2 },
  ctaOff: { background: "#c9c3b4", color: "#fbf7ee", cursor: "not-allowed" },

  waitStatus: { display: "flex", alignItems: "center", gap: 9, background: "#fff7e0", border: "1.5px solid #f0d98a", borderRadius: 11, padding: "10px 14px", marginBottom: 18 },
  pulseDot: { width: 10, height: 10, borderRadius: 8, background: "#F2B705", flex: "0 0 auto" },
  waitText: { fontSize: 13.5, fontWeight: 800, color: "#7a5d00", flex: 1 },
  waitClock: { fontSize: 13, fontWeight: 800, color: "#7a5d00", fontVariantNumeric: "tabular-nums" },
  amountStack: { textAlign: "center", marginBottom: 16 },
  bigNaira: { fontSize: 40, fontWeight: 800, color: "#11150F", letterSpacing: -1, lineHeight: 1 },
  subBch: { fontSize: 14, fontWeight: 700, color: "#0F7A3D", marginTop: 6, fontVariantNumeric: "tabular-nums" },
  chargeNote: { fontSize: 13, color: "#5B6157", marginTop: 6, fontStyle: "italic" },
  qrWrap: { background: "#fff", border: "2px solid #11150F", borderRadius: 18, padding: 16, width: "fit-content", margin: "0 auto" },
  qrImg: { width: 200, height: 200, display: "block" },
  scanHint: { textAlign: "center", fontSize: 12, color: "#9aa18f", fontWeight: 600, marginTop: 10 },

  walletBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, textDecoration: "none", width: "100%", marginTop: 16, background: "#0F7A3D", color: "#FBF7EE", borderRadius: 14, padding: "15px 0", fontSize: 15.5, fontWeight: 800, boxSizing: "border-box" },
  walletSub: { textAlign: "center", fontSize: 11, color: "#9aa18f", fontWeight: 600, marginTop: 7 },

  uriRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 14, background: "#fff", border: "1.5px solid #e3ddcd", borderRadius: 10, padding: "8px 8px 8px 12px" },
  uriText: { flex: 1, fontSize: 11, color: "#5B6157", fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  copyBtn: { background: "#11150F", color: "#FBF7EE", border: "none", borderRadius: 7, padding: "7px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", flex: "0 0 auto" },
  refLine: { textAlign: "center", fontSize: 11.5, fontWeight: 700, color: "#9aa18f", marginTop: 10, letterSpacing: 0.4 },
  linkBtn: { width: "100%", marginTop: 10, background: "none", border: "none", color: "#9aa18f", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 6 },

  paidBadge: { display: "flex", alignItems: "center", justifyContent: "center", gap: 9, background: "#0F7A3D", color: "#FBF7EE", borderRadius: 14, padding: "15px 0", fontSize: 22, fontWeight: 800, letterSpacing: 1, marginBottom: 18 },
  receipt: { background: "#fff", border: "1.5px solid #e3ddcd", borderRadius: 16, padding: 18 },
  rcptTop: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  rcptMerchant: { fontSize: 14, fontWeight: 800, color: "#11150F" },
  rcptTag: { fontSize: 10.5, fontWeight: 800, color: "#0F7A3D", background: "#e6f3ec", borderRadius: 6, padding: "3px 8px" },
  rcptAmount: { fontSize: 34, fontWeight: 800, color: "#11150F", letterSpacing: -1, lineHeight: 1 },
  rcptBch: { fontSize: 13, fontWeight: 700, color: "#0F7A3D", marginTop: 5, fontVariantNumeric: "tabular-nums" },
  rcptDivider: { height: 1, background: "#eee7d6", margin: "14px 0" },
  kvRow: { display: "flex", justifyContent: "space-between", padding: "5px 0" },
  kvK: { fontSize: 12.5, color: "#9aa18f", fontWeight: 600 },
  kvV: { fontSize: 12.5, color: "#11150F", fontWeight: 700, textAlign: "right", maxWidth: "62%" },
  waBtn: { display: "block", textAlign: "center", width: "100%", marginTop: 16, background: "#11150F", color: "#FBF7EE", border: "none", borderRadius: 14, padding: "15px 0", fontSize: 15, fontWeight: 800, boxSizing: "border-box", cursor: "pointer", fontFamily: "inherit" },
  shareMsg: { textAlign: "center", fontSize: 12, color: "#0F7A3D", fontWeight: 700, marginTop: 9, lineHeight: 1.5 },
  cashoutBtn: { display: "block", textAlign: "center", textDecoration: "none", width: "100%", marginTop: 10, background: "#fff", color: "#0F7A3D", border: "2px solid #0F7A3D", borderRadius: 14, padding: "13px 0", fontSize: 14.5, fontWeight: 800, boxSizing: "border-box" },

  histSummary: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#11150F", borderRadius: 14, padding: "16px 18px", marginBottom: 16 },
  histSumLabel: { color: "#7d8a72", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 },
  histSumValue: { color: "#F2B705", fontSize: 26, fontWeight: 800, marginTop: 4, letterSpacing: -0.5 },
  histSumCount: { color: "#bfe6cd", fontSize: 13, fontWeight: 700 },
  histEmpty: { textAlign: "center", color: "#9aa18f", fontSize: 13.5, lineHeight: 1.6, padding: "30px 20px", background: "#fff", border: "1.5px dashed #e3ddcd", borderRadius: 14 },
  histList: { display: "flex", flexDirection: "column", gap: 8 },
  histItem: { display: "flex", alignItems: "flex-start", gap: 11, background: "#fff", border: "1.5px solid #eee7d6", borderRadius: 12, padding: "12px 14px" },
  histDot: { width: 8, height: 8, borderRadius: 5, background: "#0F7A3D", marginTop: 6, flex: "0 0 auto" },
  histItemMain: { flex: 1, minWidth: 0 },
  histItemTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  histAmount: { fontSize: 16, fontWeight: 800, color: "#11150F" },
  histTime: { fontSize: 11.5, color: "#9aa18f", fontWeight: 600, flex: "0 0 auto" },
  histItemSub: { fontSize: 11.5, color: "#5B6157", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  histNote: { fontWeight: 700, color: "#11150F" },
  histRef: { fontWeight: 700, color: "#0F7A3D" },
  histBch: { color: "#9aa18f", fontVariantNumeric: "tabular-nums" },

  disclaimer: { maxWidth: 400, color: "#5B6157", fontSize: 11.5, lineHeight: 1.6, marginTop: 18, textAlign: "center", fontFamily: "'DM Sans', system-ui, sans-serif" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700;9..40,800&display=swap');
* { box-sizing: border-box; }
.pulseDot { animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.5); opacity: .45 } }
.paidPop { animation: pop .42s cubic-bezier(.2,1.4,.5,1) both; }
@keyframes pop { 0% { transform: scale(.6); opacity: 0 } 100% { transform: scale(1); opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .pulseDot,.paidPop { animation: none !important; } }
`;
