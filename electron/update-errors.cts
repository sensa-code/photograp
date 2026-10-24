/**
 * Turns an update failure into one short sentence a user can act on.
 *
 * electron-updater's errors are written for developers: several lines of
 * English with the HTTP status, every response header and a stack trace. The
 * raw error still goes to updater.log; this only picks what the user sees.
 *
 * No electron import here, so `tests/update-errors.check.cjs` can run the
 * compiled file with plain node.
 */

export const RELEASES_URL = 'https://github.com/sensa-code/photograp/releases';

export type UpdateErrorKind = 'offline' | 'rate-limited' | 'not-found' | 'other';
/** What was being done when it failed; only the fallback sentence differs. */
export type UpdateStage = 'check' | 'download';

/** Node socket and DNS failures, reported in `code`. */
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EPIPE',
]);
/** The same failures as they appear in a message, including Chromium's net::ERR_* names. */
const NETWORK_MESSAGE =
  /\bERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_[A-Z_]+|NETWORK_[A-Z_]+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED)\b|\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH)\b|socket hang up/i;
const RATE_LIMIT_STATUSES = new Set([403, 429]);
const RATE_LIMIT_MESSAGE = /rate limit|too many requests|HttpError: (403|429)\b/i;
const NOT_FOUND_CODES = new Set(['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND']);
/**
 * The wording of those two errors, for when they reach us wrapped again: a 404
 * from /releases/latest (no full release yet, or only pre-releases) comes back
 * as ERR_UPDATER_INVALID_RELEASE_FEED with the inner code gone from the text.
 */
const NOT_FOUND_MESSAGE = /Cannot find latest[\w.-]*\.yml|Unable to find latest version on GitHub|ERR_UPDATER_(LATEST_VERSION|CHANNEL_FILE)_NOT_FOUND/;

const SENTENCES: Record<Exclude<UpdateErrorKind, 'other'>, string> = {
  offline: '連不上更新伺服器，請確認網路後再試。',
  'rate-limited': 'GitHub 暫時限制了請求次數，請過幾分鐘再試。',
  'not-found': '暫時讀不到最新版本的資訊（新版本剛發布時可能要等幾分鐘），請稍後再試。',
};
const FALLBACK: Record<UpdateStage, string> = {
  check: '檢查更新失敗，請稍後再試。',
  download: '新版本下載失敗，可以稍後再用「說明 › 檢查更新…」重試。',
};
const MANUAL_DOWNLOAD = `也可以到 ${RELEASES_URL} 手動下載。`;

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[name] : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = field(error, 'message');
  return typeof message === 'string' ? message : String(error);
}

export function classifyUpdateError(error: unknown): UpdateErrorKind {
  const rawCode = field(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode : '';
  const rawStatus = field(error, 'statusCode');
  const status = typeof rawStatus === 'number' ? rawStatus : 0;
  const message = messageOf(error);

  // The error's own code or HTTP status says it directly.
  if (NETWORK_CODES.has(code)) return 'offline';
  if (RATE_LIMIT_STATUSES.has(status) || code === 'HTTP_ERROR_403' || code === 'HTTP_ERROR_429') return 'rate-limited';
  // electron-updater wraps whatever went wrong while finding the latest release
  // (offline, rate limited, a missing latest.yml) in its own *_NOT_FOUND code
  // and keeps the cause only in the message, so the message is read before the
  // wrapper's code decides.
  if (NETWORK_MESSAGE.test(message)) return 'offline';
  if (RATE_LIMIT_MESSAGE.test(message)) return 'rate-limited';
  if (NOT_FOUND_CODES.has(code) || NOT_FOUND_MESSAGE.test(message)) return 'not-found';
  return 'other';
}

/** The sentence shown to the user, ending with where to download by hand. */
export function describeUpdateError(error: unknown, stage: UpdateStage = 'check'): string {
  const kind = classifyUpdateError(error);
  return `${kind === 'other' ? FALLBACK[stage] : SENTENCES[kind]}${MANUAL_DOWNLOAD}`;
}
