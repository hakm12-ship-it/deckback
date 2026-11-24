/**
 * Offline use (spec §3): registers the service worker (sw.ts, built to `/sw.js`) in a production build, and, once the page
 * has loaded and is idle, asks it to cache the conversion worker and pdf.js too. After that the page opens and converts
 * with the network off. The first load is the page alone: those files are fetched after it, at idle, never with it.
 */

const WARM_AFTER_MS = 3_000;

export function registerOffline(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const warm = (): void => {
    void navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage('warm'));
  };
  addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).then(
      () => {
        // not on a connection the user asked to spare
        if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true) return;
        setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(warm, { timeout: 10_000 }) : warm()), WARM_AFTER_MS);
      },
      () => undefined, // no service worker (a private window, say): the page works online all the same
    );
  });
}
