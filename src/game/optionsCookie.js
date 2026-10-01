// Options persistence: the Options menu's settings are kept in a cookie, saved whenever the
// player leaves the Options menu and read back when the page loads.

const COOKIE = 'gridGameOptions';
const MAX_AGE_S = 60 * 60 * 24 * 365; // keep for a year

/** Saves `options` (a plain object of Options settings) to the cookie. */
export function saveOptionsCookie(options) {
  try {
    const value = encodeURIComponent(JSON.stringify(options));
    document.cookie = `${COOKIE}=${value}; max-age=${MAX_AGE_S}; path=/; SameSite=Lax`;
  } catch {
    /* cookies unavailable (e.g. blocked): nothing is saved */
  }
}

/** The saved Options settings, or null if there are none (or they can't be read). */
export function loadOptionsCookie() {
  try {
    const entry = document.cookie.split('; ').find((cookie) => cookie.startsWith(`${COOKIE}=`));
    if (!entry) return null;
    const data = JSON.parse(decodeURIComponent(entry.slice(COOKIE.length + 1)));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}
