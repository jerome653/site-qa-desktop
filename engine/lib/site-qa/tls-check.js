'use strict';
// site-qa/tls-check.js — real TLS certificate inspection via node's tls module (free, no deps).
// Reads the ACTUAL served certificate: validity, days-to-expiry, hostname match, issuer.
// Moves "SSL valid" out of the manual checklist into a real, deterministic check. No pretend —
// if the handshake fails we report exactly why.

const tls = require('tls');

function tlsCheck(host, port = 443, timeout = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { socket.destroy(); } catch (e) {} resolve(r); };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const authErr = socket.authorizationError ? String(socket.authorizationError) : null;
      let validTo = null, daysRemaining = null;
      if (cert && cert.valid_to) {
        validTo = cert.valid_to;
        daysRemaining = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
      }
      // hostname match: CN or any SAN DNS entry (wildcard-aware)
      const cn = cert && cert.subject && cert.subject.CN ? cert.subject.CN : '';
      const sans = (cert && cert.subjectaltname ? cert.subjectaltname : '').split(',').map(s => s.replace(/^\s*DNS:/i, '').trim()).filter(Boolean);
      const names = [cn, ...sans].filter(Boolean);
      const hostMatch = names.some(n => n === host || (n.startsWith('*.') && host.endsWith(n.slice(1))));
      let protocol = null, cipher = null;
      try { protocol = socket.getProtocol(); } catch (e) {}
      try { cipher = (socket.getCipher() || {}).name || null; } catch (e) {}
      finish({
        reachable: true, authorized, error: authErr,
        validTo, daysRemaining, hostMatch, protocol, cipher,
        issuer: cert && cert.issuer && (cert.issuer.O || cert.issuer.CN) || null,
        subject: cn || null, names: names.slice(0, 6),
      });
    });
    socket.on('error', (e) => finish({ reachable: false, error: String(e && e.message || e), daysRemaining: null }));
    socket.on('timeout', () => finish({ reachable: false, error: 'connection timeout', daysRemaining: null }));
  });
}

module.exports = { tlsCheck };
