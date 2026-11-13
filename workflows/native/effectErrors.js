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


// Only a terminal failure reported by a verified, pinned native child
// executable is a confirmed workflow.run failure. Transport/configuration
// errors must remain unclassified so retries cannot mask unknown effects.
export class NativeConfirmedWorkflowFailure extends Error {
  constructor(nativeError) {
    const detail = typeof nativeError === 'string' ? nativeError :
      nativeError && typeof nativeError.message === 'string' ?
        nativeError.message : 'native child workflow failed';
    super(detail.slice(0, 256));
    this.name = 'NativeConfirmedWorkflowFailure';
    this.nativeError = nativeError;
  }
}
