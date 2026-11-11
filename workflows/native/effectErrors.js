// Only a confirmed HTTP response can become a catchable native workflow
// error. Never wrap timeouts, transport failures, policy denials or unknown
// remote outcomes: those remain unresolved for reconciliation.
export class NativeConfirmedHttpFailure extends Error {
  constructor(status) {
    if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
      throw new Error('invalid confirmed HTTP failure status');
    }
    super(`HTTP ${status}`);
    this.name = 'NativeConfirmedHttpFailure';
    this.status = status;
  }
}
