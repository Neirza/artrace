"use strict";

/*
  Artee — one-click phone launcher.

  Serves this folder and exposes it through a free Cloudflare quick tunnel, so
  the phone only has to scan a QR code (any network — no same-Wi-Fi, cables or
  tethering). If the tunnel can't start, a USB tether / local address is used
  instead.

  Just double-click start-phone.bat — no commands, no IP hunting.
*/

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec, spawn } = require("child_process");

const ROOT = __dirname;
const BASE_PORT = 8000;
const MAX_PORT_TRIES = 25;

// Shared project store. The phone and the PC both read/write here, so the
// gallery shows the exact same artworks on every device.
const DATA_DIR = process.env.ARTEE_DATA_DIR || path.join(ROOT, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function listIPv4() {
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if ((info.family === "IPv4" || info.family === 4) && !info.internal) {
        all.push({ name, address: info.address });
      }
    }
  }
  return all;
}

// USB tether interfaces: Android (RNDIS/NCM, 192.168.42.x) and
// iPhone/iPad ("Apple Mobile Device Ethernet", 172.20.10.x).
const TETHER_NAME = /(apple mobile|remote ndis|rndis|\bncm\b|usb.*ether|ether.*usb)/i;
const TETHER_SUBNET = /^(192\.168\.42\.|172\.20\.10\.)/;

function detectTetherIp() {
  const all = listIPv4();
  const byName = all.find((c) => TETHER_NAME.test(c.name));
  if (byName) return byName.address;
  const bySubnet = all.find((c) => TETHER_SUBNET.test(c.address));
  return bySubnet ? bySubnet.address : null;
}

// Fallback address when no tether is up. Skip VPN / virtual adapters so we
// don't hand out something unreachable (e.g. Cloudflare WARP).
function detectLanIp() {
  const all = listIPv4();
  const PHYSICAL = /(wi-?fi|wlan|ethernet|^en\d|^eth\d)/i;
  const AVOID = /(warp|vpn|tailscale|zerotier|virtual|vmware|vbox|hyper-?v|loopback|bluetooth|tunnel)/i;
  const physical = all.filter((c) => PHYSICAL.test(c.name) && !AVOID.test(c.name));
  if (physical.length) return physical[0].address;
  const plain = all.filter((c) => !AVOID.test(c.name));
  if (plain.length) return plain[0].address;
  return all.length ? all[0].address : "127.0.0.1";
}

function connectPage(url, localUrl) {
  const safe = JSON.stringify(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Artee to your phone</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:20px; background:#1b1b1e; color:#eee; padding:28px 18px; text-align:center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size:20px; font-weight:700; margin:0; letter-spacing:.2px; }
  #qr { background:#fff; padding:14px; border-radius:14px; line-height:0;
    box-shadow:0 10px 40px rgba(0,0,0,.55); }
  #qr img { display:block; width:min(60vw,300px); height:auto; }
  .url { font-family: ui-monospace, Consolas, monospace; font-size:15px; font-weight:600; color:#7cc4ff;
    background:#26262b; border:1px solid #34343c; padding:9px 16px; border-radius:10px; user-select:all;
    word-break:break-all; }
  p { margin:0; color:#9aa0aa; font-size:13px; line-height:1.55; max-width:460px; }
  .steps b { color:#d6d6dc; }
  a.open { color:#7cc4ff; font-size:12.5px; }
  .warn { color:#e8b04b; font-size:12px; }
</style>
</head>
<body>
  <h1>Open Artee on your phone</h1>
  <div id="qr"></div>
  <div class="url" id="url"></div>
  <p class="steps">
    <b>1.</b> Make sure your phone has internet (Wi-Fi or mobile data).<br>
    <b>2.</b> Scan the QR code with your phone camera — or open the address above.
  </p>
  <p class="warn" id="warn">Getting ready… first time only, this takes about 10 seconds.</p>
  <p><a class="open" href="${localUrl}">Open Artee on this PC</a></p>
  <script src="/qrcode.js"></script>
  <script>
    var url = ${safe};
    var lastQr = "";
    function show(u) {
      document.getElementById("url").textContent = u;
      if (u === lastQr) return;
      lastQr = u;
      try {
        var qr = qrcode(0, "M");
        qr.addData(u);
        qr.make();
        document.getElementById("qr").innerHTML = qr.createImgTag(6, 10);
      } catch (e) {
        document.getElementById("warn").textContent =
          "QR could not be generated — just type the address above into your phone browser.";
      }
    }
    function poll() {
      fetch("/__status").then(function (r) { return r.json(); }).then(function (s) {
        show(s.url);
        document.getElementById("warn").textContent = s.ready
          ? ""
          : "Getting ready… first time only, this takes about 10 seconds.";
      }).catch(function () {});
    }
    show(url);
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

function sendFile(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

/* ═══════════════════════════════════════════════════
   SHARED PROJECT STORE  (HTTP key/value in data/)
   ═══════════════════════════════════════════════════ */

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

function kvFile(key) {
  return path.join(DATA_DIR, encodeURIComponent(key) + ".json");
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(obj));
}

// Returns true when the request was an API call (handled here).
async function handleApi(req, res, pathname) {
  if (pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/kv/keys" && req.method === "GET") {
    let keys = [];
    try {
      keys = fs.readdirSync(DATA_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => decodeURIComponent(f.slice(0, -5)));
    } catch (e) { /* empty store */ }
    sendJson(res, 200, { keys });
    return true;
  }

  if (pathname === "/api/kv/chunk") {
    const params = new URL(req.url, "http://localhost").searchParams;
    const key = params.get("key") || "";
    const i = Number(params.get("i"));
    const total = Number(params.get("total"));
    const off = Number(params.get("off"));
    if (!SAFE_KEY.test(key) || !Number.isInteger(i) || !Number.isInteger(total) ||
        !Number.isInteger(off) || total < 1 || i < 0 || i >= total || off < 0) {
      sendJson(res, 400, { error: "bad chunk params" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return true;
    }
    const file = kvFile(key);
    const tmp = file + ".tmp";
    try {
      const chunk = await readBody(req, 64 * 1024 * 1024);
      if (i === 0) {
        await fs.promises.writeFile(tmp, chunk);
      } else {
        let st;
        try { st = await fs.promises.stat(tmp); } catch (e) {
          sendJson(res, 409, { error: "no partial upload" });
          return true;
        }
        if (st.size !== off) {
          sendJson(res, 409, { error: "offset mismatch" });
          return true;
        }
        await fs.promises.appendFile(tmp, chunk);
      }
      if (i === total - 1) {
        // Atomic publish: readers only ever see the complete payload.
        await fs.promises.rename(tmp, file);
        wsBroadcast({ type: "saved", key }, null);
      }
      sendJson(res, 200, { ok: true, i, total });
    } catch (e) {
      sendJson(res, 400, { error: String((e && e.message) || e) });
    }
    return true;
  }

  if (pathname === "/api/kv") {
    const key = new URL(req.url, "http://localhost").searchParams.get("key") || "";
    if (!SAFE_KEY.test(key)) {
      sendJson(res, 400, { error: "bad key" });
      return true;
    }
    const file = kvFile(key);

    if (req.method === "GET") {
      try {
        const raw = await fs.promises.readFile(file, "utf8");
        sendJson(res, 200, { key, value: JSON.parse(raw) });
      } catch (e) {
        sendJson(res, 404, { error: "not found" });
      }
      return true;
    }

    if (req.method === "POST") {
      try {
        const body = await readBody(req, 512 * 1024 * 1024);
        const parsed = JSON.parse(body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || !("value" in parsed)) throw new Error("bad body");
        // Write to a temp file and rename, so a concurrent reader (another
        // device opening the project mid-save) never sees a torn payload.
        const tmp = file + ".tmp";
        await fs.promises.writeFile(tmp, JSON.stringify(parsed.value));
        await fs.promises.rename(tmp, file);
        wsBroadcast({ type: "saved", key }, null);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: String((e && e.message) || e) });
      }
      return true;
    }

    if (req.method === "DELETE") {
      try { await fs.promises.unlink(file); } catch (e) { /* already gone */ }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

/* ═══════════════════════════════════════════════════
   LIVE SYNC  (RFC 6455 WebSocket, no dependencies)
   Strokes are relayed to every other connected device.
   ═══════════════════════════════════════════════════ */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_MSG = 512 * 1024;
const wsClients = new Set();

function wsAcceptKey(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function wsEncodeFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsBroadcast(obj, except) {
  if (!wsClients.size) return;
  const frame = wsEncodeFrame(JSON.stringify(obj));
  for (const c of wsClients) {
    if (c === except) continue;
    try { c.write(frame); } catch (e) { /* dropped client */ }
  }
}

function attachWebSocket(server) {
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n\r\n"
    );
    socket.setNoDelay(true);
    wsClients.add(socket);
    console.log(`  live: a device connected (${wsClients.size} online)`);

    let buf = Buffer.alloc(0);
    let fragments = [];

    const drop = () => {
      wsClients.delete(socket);
      try { socket.destroy(); } catch (e) { /* already gone */ }
    };

    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) return;
          len = buf.readUInt16BE(off); off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) return;
          const big = buf.readBigUInt64BE(off); off += 8;
          if (big > BigInt(WS_MAX_MSG)) { drop(); return; }
          len = Number(big);
        }
        if (len > WS_MAX_MSG) { drop(); return; }
        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4); off += 4;
        }
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (mask) {
          const un = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
          payload = un;
        }
        buf = buf.subarray(off + len);

        if (opcode === 0x8) { try { socket.end(); } catch (e) { } drop(); return; }
        if (opcode === 0x9) {
          const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
          try { socket.write(pong); } catch (e) { }
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x2) { drop(); return; }
        if (opcode === 0x1 || opcode === 0x0) {
          fragments.push(payload);
          if (!fin) {
            let total = 0;
            for (const f of fragments) total += f.length;
            if (total > WS_MAX_MSG) { drop(); return; }
            continue;
          }
          const msgBuf = Buffer.concat(fragments);
          fragments = [];
          let msg = null;
          try { msg = JSON.parse(msgBuf.toString("utf8")); } catch (e) { continue; }
          if (msg && typeof msg === "object" &&
              (msg.type === "stroke" || msg.type === "restore" || msg.type === "clearlayer" ||
               msg.type === "refimg" || msg.type === "refstate" || msg.type === "ref-request" ||
               msg.type === "sync-request" || msg.type === "sync")) {
            wsBroadcast(msg, socket);
          }
        }
      }
    });

    socket.on("close", () => { wsClients.delete(socket); });
    socket.on("error", () => drop());
  });
}

async function handleRequest(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    pathname = "/";
  }

  // Log only traffic that comes from another device (the phone), so you can
  // see whether the phone actually reached this server.
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (remote && remote !== "127.0.0.1" && remote !== "::1") {
    console.log(`  phone -> ${req.method} ${pathname}   (from ${remote})`);
  }

  try {
    if (await handleApi(req, res, pathname)) return;
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
    return;
  }

  if (pathname === "/__connect") {
    const body = connectPage(bestUrl(), `http://127.0.0.1:${activePort}/`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }

  if (pathname === "/__status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ url: bestUrl(), ready: !!(tunnelUrl || tethered) }));
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  // Resolve inside ROOT only (no directory traversal).
  const target = path.normalize(path.join(ROOT, pathname));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  fs.stat(target, (err, stat) => {
    if (!err && stat.isDirectory()) {
      sendFile(req, res, path.join(target, "index.html"));
    } else {
      sendFile(req, res, target);
    }
  });
}

function openBrowser(url) {
  let cmd;
  if (process.platform === "win32") cmd = `start "" "${url}"`;
  else if (process.platform === "darwin") cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, () => {});
}

let tethered = false;
let tunnelUrl = null;
let lanIp = detectTetherIp() || detectLanIp();
let activePort = BASE_PORT;

function bestUrl() {
  if (tunnelUrl) return tunnelUrl;
  return `http://${lanIp}:${activePort}/`;
}

// Free Cloudflare quick tunnel: the phone reaches us through it, so no
// same-Wi-Fi, firewall or tethering is needed. npx downloads it once.
function startTunnel(port) {
  console.log("  Setting up the phone connection (first time only: a one-time");
  console.log("  download of a small helper, ~10 seconds)...");
  const child = spawn(
    `npx -y cloudflared tunnel --url http://127.0.0.1:${port}/`,
    { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !tunnelUrl) {
      tunnelUrl = m[0];
      console.log("");
      console.log("  Phone ready — scan the QR on the connect page, or open:");
      console.log("  " + tunnelUrl);
      console.log("");
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  child.on("error", (err) => {
    console.log("");
    console.log("  Could not start the phone connection: " + err.message);
    console.log("  Fallback: plug in the phone with a USB cable and turn on");
    console.log("  USB tethering — its address will appear here instead.");
  });
  child.on("exit", () => { tunnelUrl = null; });
}

function onListening(port) {
  activePort = port;
  tethered = !!detectTetherIp();
  if (tethered) lanIp = detectTetherIp();
  const localUrl = `http://127.0.0.1:${port}/`;
  const connectUrl = `http://127.0.0.1:${port}/__connect`;

  console.log("");
  console.log("  Artee is ready.");
  console.log("  ──────────────────────────────────────────────");
  console.log("  On this PC:      " + localUrl);
  console.log("  On your phone:   " + (tunnelUrl || (tethered ? bestUrl() : "preparing the QR code...")));
  console.log("  ──────────────────────────────────────────────");
  console.log("");
  console.log("  A connect page is opening in your browser — scan the QR");
  console.log("  code with your phone (the phone needs internet) to start");
  console.log("  drawing.");
  console.log("");
  console.log("  Keep this window open while you use the app.");
  console.log("  Close it (or press Ctrl+C) when you are done.");
  console.log("");

  startTunnel(port);
  openBrowser(connectUrl);
}

// Watch for the phone being plugged in / tether turned on (or off) — used as
// a fallback when the tunnel can't start.
setInterval(() => {
  const tether = detectTetherIp();
  if (tether) {
    if (!tethered || tether !== lanIp) {
      tethered = true;
      lanIp = tether;
      console.log("");
      console.log("  Phone detected — on your phone open:  " + `http://${lanIp}:${activePort}/`);
      console.log("");
    }
  } else if (tethered) {
    tethered = false;
    console.log("  Phone tethering disconnected.");
  }
}, 2000);

function startServer(port, triesLeft) {
  const server = http.createServer(handleRequest);
  attachWebSocket(server);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && triesLeft > 0) {
      startServer(port + 1, triesLeft - 1);
    } else {
      console.error("");
      console.error("  Could not start the server: " + err.message);
      console.error("");
      process.exit(1);
    }
  });
  server.listen(port, "0.0.0.0", () => onListening(port));
}

// Is something already answering HTTP on this port (on either loopback)?
function probeHost(host, port, cb) {
  const req = http.request(
    { host, port, path: "/__artee_probe", method: "GET", timeout: 500 },
    (res) => { res.resume(); cb(true); }
  );
  req.on("error", () => cb(false));
  req.on("timeout", () => { req.destroy(); cb(false); });
  req.end();
}

function isPortBusy(port, cb) {
  probeHost("127.0.0.1", port, (v4) => {
    if (v4) return cb(true);
    probeHost("::1", port, cb);
  });
}

function findPort(port, triesLeft, cb) {
  isPortBusy(port, (busy) => {
    if (!busy || triesLeft <= 0) return cb(port);
    findPort(port + 1, triesLeft - 1, cb);
  });
}

findPort(BASE_PORT, MAX_PORT_TRIES, (port) => startServer(port, MAX_PORT_TRIES));
