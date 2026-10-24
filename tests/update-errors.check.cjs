/**
 * Plain-node check for electron/update-errors.cts: every kind of update
 * failure turns into its short sentence, never the raw error. Run through
 * `npm run test:electron`, which compiles electron/ first.
 */
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { classifyUpdateError, describeUpdateError, RELEASES_URL } = require(join(__dirname, '..', 'dist-electron', 'update-errors.cjs'));

/** Same shape as builder-util-runtime's newError(): an Error with a `code`. */
function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Same shape as builder-util-runtime's HttpError. */
function httpError(statusCode, statusMessage) {
  const error = new Error(`${statusCode} ${statusMessage}\nHeaders: {\n  "server": "github.com"\n}`);
  error.name = 'HttpError';
  error.statusCode = statusCode;
  error.code = `HTTP_ERROR_${statusCode}`;
  return error;
}

const OFFLINE = '連不上更新伺服器，請確認網路後再試。';
const RATE_LIMITED = 'GitHub 暫時限制了請求次數，請過幾分鐘再試。';
const NOT_FOUND = '暫時讀不到最新版本的資訊（新版本剛發布時可能要等幾分鐘），請稍後再試。';
const CHECK_FAILED = '檢查更新失敗，請稍後再試。';
const DOWNLOAD_FAILED = '新版本下載失敗，可以稍後再用「說明 › 檢查更新…」重試。';
const TAIL = `也可以到 ${RELEASES_URL} 手動下載。`;

const cases = [
  ['Chromium 離線', new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline', OFFLINE],
  ['DNS 查不到', new Error('net::ERR_NAME_NOT_RESOLVED'), 'offline', OFFLINE],
  ['連線被重設', new Error('net::ERR_CONNECTION_RESET'), 'offline', OFFLINE],
  ['Node ENOTFOUND（code）', coded('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND'), 'offline', OFFLINE],
  ['Node ETIMEDOUT（code）', coded('connect ETIMEDOUT 140.82.112.3:443', 'ETIMEDOUT'), 'offline', OFFLINE],
  ['ECONNRESET（只有訊息）', new Error('read ECONNRESET'), 'offline', OFFLINE],
  ['離線被包成 LATEST_VERSION_NOT_FOUND',
    coded('Unable to find latest version on GitHub (https://github.com/sensa-code/photograp/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:114213)', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'),
    'offline', OFFLINE],
  ['HttpError 403', httpError(403, 'Forbidden'), 'rate-limited', RATE_LIMITED],
  ['HttpError 429', httpError(429, 'Too Many Requests'), 'rate-limited', RATE_LIMITED],
  ['訊息含 rate limit', new Error('API rate limit exceeded for 1.2.3.4.'), 'rate-limited', RATE_LIMITED],
  ['403 被包成 LATEST_VERSION_NOT_FOUND',
    coded('Unable to find latest version on GitHub (https://github.com/sensa-code/photograp/releases/latest), please ensure a production release exists: HttpError: 403 Forbidden\nHeaders: {}\n    at createHttpError (C:\\app\\node_modules\\builder-util-runtime\\out\\httpExecutor.js:53:12)', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'),
    'rate-limited', RATE_LIMITED],
  ['latest.yml 404（指揮官實測的那串）',
    coded('Cannot find latest.yml in the latest release artifacts (https://github.com/sensa-code/photograp/releases/download/v1.1.1/latest.yml): HttpError: 404 \nHeaders: {\n  "content-type": "text/plain; charset=utf-8",\n  "x-github-request-id": "C0DE:1234:ABCD"\n}\n    at createHttpError (C:\\app\\node_modules\\builder-util-runtime\\out\\httpExecutor.js:53:12)', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'),
    'not-found', NOT_FOUND],
  ['LATEST_VERSION_NOT_FOUND（原因不明）', coded('Unable to find latest version on GitHub, please ensure a production release exists: Error: Unexpected token', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'), 'not-found', NOT_FOUND],
  ['/releases/latest 404 被二次包成 INVALID_RELEASE_FEED',
    coded('Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/sensa-code/photograp/releases/latest), please ensure a production release exists: HttpError: 404 \nHeaders: {}\n    at createHttpError (C:\\app\\node_modules\\builder-util-runtime\\out\\httpExecutor.js:53:12),\nXML:\n<feed></feed>', 'ERR_UPDATER_INVALID_RELEASE_FEED'),
    'not-found', NOT_FOUND],
  ['403 被二次包成 INVALID_RELEASE_FEED 仍算限流',
    coded('Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/sensa-code/photograp/releases/latest), please ensure a production release exists: HttpError: 403 Forbidden\nHeaders: {},\nXML:\n<feed></feed>', 'ERR_UPDATER_INVALID_RELEASE_FEED'),
    'rate-limited', RATE_LIMITED],
  ['離線被二次包成 INVALID_RELEASE_FEED 仍算離線',
    coded('Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/sensa-code/photograp/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED,\nXML:\n<feed></feed>', 'ERR_UPDATER_INVALID_RELEASE_FEED'),
    'offline', OFFLINE],
  ['latest.yml 404 只有訊息', new Error('Cannot find latest.yml in the latest release artifacts (https://example.test/latest.yml): HttpError: 404'), 'not-found', NOT_FOUND],
  ['sha512 不符', coded('sha512 checksum mismatch, expected abc, got def', 'ERR_CHECKSUM_MISMATCH'), 'other', CHECK_FAILED],
  ['不是 Error 的值', 'something odd', 'other', CHECK_FAILED],
  ['undefined', undefined, 'other', CHECK_FAILED],
];

let failed = 0;
for (const [name, error, kind, sentence] of cases) {
  try {
    assert.equal(classifyUpdateError(error), kind, 'classification');
    const shown = describeUpdateError(error);
    assert.equal(shown, sentence + TAIL, 'sentence');
    assert.ok(!/Headers|HttpError|\bat \w|\n/.test(shown), 'raw error leaked');
    console.log(`PASS ${name} -> ${kind}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// The download dialog uses the same sentences; only the fallback names the download.
try {
  assert.equal(describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'), 'download'), OFFLINE + TAIL);
  assert.equal(describeUpdateError(coded('sha512 checksum mismatch', 'ERR_CHECKSUM_MISMATCH'), 'download'), DOWNLOAD_FAILED + TAIL);
  console.log('PASS download stage');
} catch (e) {
  failed += 1;
  console.log(`FAIL download stage: ${e.message}`);
}

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log(`all ${cases.length + 1} update-error checks passed`);
