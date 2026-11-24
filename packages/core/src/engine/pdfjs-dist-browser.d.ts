// pdfjs-dist ships types for the package root and the legacy build only. The browser build has the same API.
declare module 'pdfjs-dist/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}

/** pdf.js' parser side ("worker"); importing it sets `globalThis.pdfjsWorker`. */
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
