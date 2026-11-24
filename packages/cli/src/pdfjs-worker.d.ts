/** pdf.js ships no types for its parser side ("worker"); importing it gives its `WorkerMessageHandler`. */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
