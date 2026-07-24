import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// happy-dom does not ship SubtleCrypto; the flick pipeline needs a real one.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
