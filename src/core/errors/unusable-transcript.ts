// A transcript that can never be extracted, as opposed to a run that failed.
//
// 19-value-to-a-user.md item 1. Any throw from `run` used to become exit 1
// with nothing on stdout, and the session was never recorded — so a
// transcript that yields no usable lines (empty, abandoned, every line a
// sidechain) stayed eligible for ever. The hook announced it at every session
// start, the skill reported "signposts crashed" for a file that is merely
// empty, and the next day it all happened again.
//
// The distinction this type draws is determinism. Both of its causes are
// properties of the bytes: the same file yields no lines, or trips the same
// redactor, every time it is read. Recording such a session as judged is
// therefore safe — it is keyed on the content hash, so a transcript that grows
// is a different key and is looked at again. Anything else that throws may be
// a disk, a lock or a bug, and is left eligible to be retried.

export class UnusableTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableTranscriptError";
  }
}
