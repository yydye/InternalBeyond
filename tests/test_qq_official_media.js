'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const media = require('../services/home-node/qq-official-manager.js');

async function testNodeAutoSelectFamilyLookupContract() {
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  function connect(lookup) {
    return new Promise(resolve => {
      let result = '';
      const socket = net.connect({ host: 'pinned-address.invalid', port, lookup, autoSelectFamily: true });
      socket.on('connect', () => { result = 'connected'; });
      socket.on('error', error => resolve(String(error && error.code || 'network-error')));
      socket.on('close', () => resolve(result || 'closed'));
    });
  }
  try {
    const scalarResult = await connect((_host, _options, callback) => callback(null, '127.0.0.1', 4));
    const arrayResult = await connect((_host, options, callback) => options.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4));
    assert.equal(scalarResult, 'ERR_INVALID_IP_ADDRESS', 'Node rejects the old scalar callback when autoSelectFamily asks for all addresses');
    assert.equal(arrayResult, 'connected', 'Node accepts the vetted address array required by all=true');
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  await testNodeAutoSelectFamilyLookupContract();
  assert.equal(media.isAllowedImageHost('multimedia.nt.qq.com.cn'), true);
  assert.equal(media.isAllowedImageHost('cdn.qpic.cn'), true);
  assert.equal(media.isAllowedImageHost('qq.com.attacker.example'), false);
  assert.equal(media.isAllowedImageHost('127.0.0.1'), false);

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const encoded = png.toString('base64');
  const decoded = media.decodeImagePayload({ mime: 'image/png', base64: encoded }, media.MEDIA_LIMITS.outboundImageBytes);
  assert.equal(decoded.mime, 'image/png');
  assert.deepEqual(decoded.buffer, png);
  decoded.buffer.fill(0);
  assert.throws(() => media.decodeImagePayload({ mime: 'image/jpeg', base64: encoded }, 1024), /image-output-invalid/);
  assert.throws(() => media.decodeImagePayload({ mime: 'image/svg+xml', base64: encoded }, 1024), /image-output-invalid/);
  assert.throws(() => media.decodeImagePayload({ mime: 'image/png', base64: 'not-base64' }, 1024), /image-output-invalid/);
  assert.throws(() => media.decodeImagePayload({ mime: 'image/png', base64: 'A'.repeat(7000000) }, 1024), /image-output-invalid/);

  await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'http://127.0.0.1/image.png' }),
    error => error && error.code === 'image-source-protocol-rejected', 'HTTP and private-network sources fail before any request');
  await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://attacker.example/image.png' }),
    error => error && error.code === 'image-source-domain-rejected', 'non-QQ image sources fail before DNS or network access');
  await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'http://multimedia.nt.qq.com.cn/image.png' }),
    error => error && error.code === 'image-source-protocol-rejected', 'non-HTTPS sources fail before DNS or network access');
  await assert.rejects(media.downloadQQImage({ content_type: 'image/png' }),
    error => error && error.code === 'image-attachment-invalid', 'missing attachment URLs are reported as malformed event fields');
  await assert.rejects(media.downloadQQImage({ url: 'https://multimedia.nt.qq.com.cn/image.png' }),
    error => error && error.code === 'image-attachment-invalid', 'missing attachment MIME fields are reported as malformed event fields');

  const savedLookup = dns.lookup;
  const savedRequest = https.request;
  const pngFixture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function stubResponse(statusCode, headers, body) {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.headers = headers || {};
    response.resume = function () {};
    response.destroy = function () { this.destroyed = true; };
    queueMicrotask(() => {
      responseHandler(response);
      if (statusCode === 200) {
        if (body) response.emit('data', Buffer.from(body));
        response.emit('end');
      }
    });
    return response;
  }
  let responseHandler;
  let responsePlan = () => ({ statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(pngFixture.length) }, body: pngFixture });
  async function withHttpMocks(run, lookup) {
    responseHandler = null;
    dns.lookup = lookup || (async () => [{ address: '8.8.8.8', family: 4 }]);
    https.request = (options, onResponse) => {
      responseHandler = onResponse;
      const request = new EventEmitter();
      request.end = function () {
        const plan = responsePlan();
        options.lookup('multimedia.nt.qq.com.cn', { all: true }, (lookupError, addresses) => {
          if (lookupError) {
            queueMicrotask(() => request.emit('error', lookupError));
            return;
          }
          if (!Array.isArray(addresses) || !addresses.length
            || !addresses.every(item => item && typeof item.address === 'string' && Number.isInteger(item.family))) {
            queueMicrotask(() => request.emit('error', Object.assign(new Error('invalid lookup result'), { code: 'ERR_INVALID_IP_ADDRESS' })));
            return;
          }
          if (plan.error) {
            queueMicrotask(() => request.emit('error', plan.error));
            return;
          }
          stubResponse(plan.statusCode, plan.headers, plan.body);
        });
      };
      request.destroy = function () { this.destroyed = true; };
      return request;
    };
    try { await run(); }
    finally { dns.lookup = savedLookup; https.request = savedRequest; }
  }

  await withHttpMocks(async () => {
    responsePlan = () => ({ statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(pngFixture.length) }, body: pngFixture });
    const downloaded = await media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' });
    assert.equal(downloaded.mime, 'image/png', 'a small, signature-checked PNG passes the real downloader path');
    assert.deepEqual(downloaded.buffer, pngFixture);
    downloaded.buffer.fill(0);

    responsePlan = () => ({ statusCode: 403, headers: {}, body: null });
    await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-http-rejected' && error.httpStatus === 403,
      'HTTP rejection is classified with only its numeric response status');

    responsePlan = () => ({ statusCode: 302, headers: { location: 'https://attacker.example/image.png' }, body: null });
    await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-redirect-rejected', 'redirects to untrusted hosts remain blocked');

    responsePlan = () => ({ statusCode: 200, headers: { 'content-type': 'image/jpeg' }, body: pngFixture });
    await assert.rejects(media.downloadQQImage({ content_type: 'image/jpeg', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-type-mismatch', 'file signatures must match declared MIME');

    responsePlan = () => ({ error: Object.assign(new Error('private connection details'), { code: 'ENETUNREACH' }) });
    await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-network-unreachable', 'network diagnostics expose only a safe error category');
  });

  await withHttpMocks(async () => {
    responsePlan = () => ({ error: Object.assign(new Error('private socket detail'), { code: 'EHOSTUNREACH' }) });
    await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-ipv6-unreachable', 'IPv6 route failures are separated from IPv4 network failures');
  }, async () => [{ address: '2606:4700:4700::1111', family: 6 }]);

  await withHttpMocks(async () => {
    await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-dns-rejected', 'private DNS answers are rejected before connecting');
  }, async () => [{ address: '10.0.0.2', family: 4 }]);

  await withHttpMocks(async () => {
    await assert.rejects(media.downloadQQImage({ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/signed-image' }),
      error => error && error.code === 'image-dns-failed', 'DNS lookup failures have a distinct safe category');
  }, async () => { throw Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' }); });

  console.log('QQ Official media source, download, HTTP, DNS, redirect, size, MIME, and payload checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
