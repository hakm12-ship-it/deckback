/**
 * The walker met an operator (or an operator use) it does not model. It fails loudly instead of guessing (strict mode); in
 * lenient mode the walker records it and goes on (`walkPage`).
 *
 * `message` names the operator and may quote what the page holds (a key, a colour, a blend mode): for the oracle tests and
 * the sweep. `reason` is fixed words only, never anything of the page, which a Scene `Note` may carry (Global Constraints,
 * Privacy).
 */
export class UnsupportedOpError extends Error {
  readonly op: string;
  readonly reason: string;

  constructor(op: string, detail?: string, reason = 'operator the walker does not model') {
    super(`walker: unsupported operator ${op}${detail === undefined ? '' : ` (${detail})`}`);
    this.name = 'UnsupportedOpError';
    this.op = op;
    this.reason = reason;
  }
}
