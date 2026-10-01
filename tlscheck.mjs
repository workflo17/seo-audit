// Reads a host's TLS certificate so the report can say when it expires and whether it
// actually covers both the bare domain and the www subdomain. rejectUnauthorized is off
// on purpose: a wrong or expired cert is exactly the kind of finding this exists to
// surface, and node:tls refuses to hand back getPeerCertificate() at all if the initial
// handshake throws.
import { connect } from "node:tls";

// "DNS:a.example.com, DNS:*.b.example.com" -> ["a.example.com", "*.b.example.com"]
function parseAltNames(san) {
  if (!san) return [];
  return san.split(",").map(s => s.trim()).filter(s => s.toLowerCase().startsWith("dns:"))
    .map(s => s.slice(4).trim().toLowerCase()).filter(Boolean);
}

// Matches a hostname against one SAN entry, wildcards cover exactly one label.
function matchesName(altName, host) {
  const h = host.toLowerCase();
  if (altName === h) return true;
  if (altName.startsWith("*.")) {
    const rest = altName.slice(2);
    const dot = h.indexOf(".");
    return dot > 0 && h.slice(dot + 1) === rest;
  }
  return false;
}

function apexOf(host) {
  const h = host.toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

// tlsInfo(host, opts) -> Promise<{ ok, host, protocol, authorized, authorizationError,
//   issuer, subject, validFrom, validTo, daysLeft, altNames, coversHost, coversWww,
//   coversApex, error }>
// Never rejects: connection failures, timeouts and DNS errors all resolve with ok:false
// and an error string, so a caller can await this in a Promise.all without a try/catch.
export function tlsInfo(host, { port = 443, timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    let socket;
    try {
      // Offering h2 in ALPN is how a browser learns the server speaks HTTP/2, so the same
      // handshake answers the HTTP-version question too. curl cannot on this machine: both
      // copies installed here are built without HTTP/2 and report every site as 1.1.
      socket = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs,
                         ALPNProtocols: ["h2", "http/1.1"] });
    } catch (e) {
      resolve({ ok: false, host, protocol: null, authorized: false, authorizationError: null,
        issuer: null, subject: null, validFrom: null, validTo: null, daysLeft: null,
        altNames: [], coversHost: false, coversWww: false, coversApex: false,
        error: String(e && e.message || e).slice(0, 200) });
      return;
    }
    socket.on("timeout", () => finish({ ok: false, host, protocol: null, authorized: false,
      authorizationError: null, issuer: null, subject: null, validFrom: null, validTo: null,
      daysLeft: null, altNames: [], coversHost: false, coversWww: false, coversApex: false,
      error: "timeout after " + timeoutMs + "ms" }));
    socket.on("error", e => finish({ ok: false, host, protocol: null, authorized: false,
      authorizationError: null, issuer: null, subject: null, validFrom: null, validTo: null,
      daysLeft: null, altNames: [], coversHost: false, coversWww: false, coversApex: false,
      error: String(e && e.message || e).slice(0, 200) }));
    socket.on("secureConnect", () => {
      try {
        const cert = socket.getPeerCertificate(false);
        if (!cert || !Object.keys(cert).length) {
          finish({ ok: false, host, protocol: socket.getProtocol(), authorized: socket.authorized,
            authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
            issuer: null, subject: null, validFrom: null, validTo: null, daysLeft: null,
            altNames: [], coversHost: false, coversWww: false, coversApex: false,
            error: "no certificate returned" });
          return;
        }
        const altNames = parseAltNames(cert.subjectaltname);
        const apex = apexOf(host);
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const daysLeft = validTo ? Math.round((validTo.getTime() - Date.now()) / 86400000) : null;
        finish({
          ok: true,
          host,
          protocol: socket.getProtocol(),
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          issuer: cert.issuer ? (cert.issuer.O || cert.issuer.CN || null) : null,
          subject: cert.subject ? (cert.subject.CN || null) : null,
          validFrom: cert.valid_from || null,
          validTo: cert.valid_to || null,
          daysLeft,
          altNames,
          coversHost: altNames.some(a => matchesName(a, host)),
          coversWww: altNames.some(a => matchesName(a, "www." + apex)),
          coversApex: altNames.some(a => matchesName(a, apex)),
          // "h2", "http/1.1", or null when the server ignored ALPN (which also means 1.1).
          alpn: socket.alpnProtocol || null,
          error: null,
        });
      } catch (e) {
        finish({ ok: false, host, protocol: null, authorized: false, authorizationError: null,
          issuer: null, subject: null, validFrom: null, validTo: null, daysLeft: null,
          altNames: [], coversHost: false, coversWww: false, coversApex: false,
          error: String(e && e.message || e).slice(0, 200) });
      }
    });
  });
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let failures = 0;
  const ok = (label, cond) => {
    console.log((cond ? "PASS" : "FAIL") + " " + label);
    if (!cond) failures++;
  };

  const matchTests = [
    [matchesName("example.com", "example.com"), true, "exact match"],
    [matchesName("*.example.com", "www.example.com"), true, "wildcard matches one label"],
    [matchesName("*.example.com", "example.com"), false, "wildcard does not match bare apex"],
    [matchesName("*.example.com", "a.b.example.com"), false, "wildcard does not match two labels"],
    [apexOf("www.example.com"), "example.com", "apexOf strips leading www."],
    [apexOf("example.com"), "example.com", "apexOf leaves bare domain alone"],
  ];
  for (const [got, want, label] of matchTests) ok(label, JSON.stringify(got) === JSON.stringify(want));

  let netAvailable = true;
  try {
    const r1 = await tlsInfo("donflo.vercel.app", { timeoutMs: 6000 });
    if (!r1.ok && /timeout|ENOTFOUND|EAI_AGAIN|network/i.test(r1.error || "")) {
      netAvailable = false;
      console.log("SKIP live donflo.vercel.app check, network looks unavailable: " + r1.error);
    } else {
      ok("donflo.vercel.app ok true", r1.ok === true);
      ok("donflo.vercel.app daysLeft > 0", typeof r1.daysLeft === "number" && r1.daysLeft > 0);
      ok("donflo.vercel.app altNames non-empty", Array.isArray(r1.altNames) && r1.altNames.length > 0);
      ok("donflo.vercel.app coversHost true", r1.coversHost === true);
      ok("donflo.vercel.app negotiates HTTP/2 over ALPN", r1.alpn === "h2");
    }
  } catch (e) {
    netAvailable = false;
    console.log("SKIP live donflo.vercel.app check, threw: " + String(e));
  }

  const r2 = await tlsInfo("localhost", { port: 1, timeoutMs: 2000 });
  ok("localhost:1 ok false", r2.ok === false);
  ok("localhost:1 has error string", typeof r2.error === "string" && r2.error.length > 0);

  if (netAvailable) {
    const r3 = await tlsInfo("this-host-does-not-exist.invalid", { timeoutMs: 5000 });
    ok("bad host ok false", r3.ok === false);
  } else {
    console.log("SKIP bad-host DNS check, network looks unavailable");
  }

  console.log(failures === 0 ? "SUMMARY: all checks passed" : "SUMMARY: " + failures + " check(s) failed");
  process.exit(failures === 0 ? 0 : 1);
}
