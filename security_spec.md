# Security Specification: StockMaster Journal

## 1. Data Invariants
- **Identity Invariant**: A user can only read and write their own profile (`/users/{userId}`) and their own trade records (`/trades/{tradeId}`). The `userId` must match the authenticated user's `uid` (or `'default-user'` if the app runs in unauthenticated preview mode).
- **Format Invariant**: Tickers must be non-empty strings (maximum 30 characters). Reasons must be strings of maximum 500 characters.
- **Value Invariant**: Price, quantity, and cash balances/deposits must be non-negative numeric types.
- **Temporal Invariant**: The `createdAt` and `updatedAt` timestamps must match the server timestamp (`request.time`).

---

## 2. The "Dirty Dozen" Payloads
Here are 12 specific JSON payloads designed to violate Identity, Integrity, and State:

### Category A: Identity Violations (Spoofing)
1. **Malicious Client Profiles (Spoof Entry)**: Authenticated user `user-123` trying to update `/users/user-abc`'s profile cash balance.
2. **Trade Creation Spoofing**: Authenticated user `user-123` trying to create a trade with `userId: "user-abc"`.
3. **Impersonate Default Profile**: Unauthenticated user trying to modify the profile `/users/admin-user`.

### Category B: Integrity & Value Sizing Violations (Resource Poisoning)
4. **Negative Capital Injection**: Create profile with negative `totalDeposits` (`-10000`).
5. **Negative Trades**: Create a buy record with negative `quantity` or negative `price`.
6. **SQL-like/Junk Ticker Poisoning**: Create trade with a massive 10KB ticker symbol of gibberish characters.
7. **Giant Logs Overload**: Create trade with a `reason` containing a 1MB string to cause Denial of Wallet storage consumption.
8. **Invalid Schema Field Leak**: Add a ghost field `isVerifiedUser: true` or `isAdmin: true` inside a user profile update.

### Category C: Temporal & State Shortcutting Violations
9. **Backdated Timestamps**: Create a trade where `createdAt` is hardcoded to a past date (e.g., `2000-01-01`) instead of `request.time`.
10. **Modified Immutable Field**: Try to update `createdAt` of an existing trade record.
11. **Spoofed User ID Shift**: Update a trade record to change its `userId` from `user-123` to `user-bcd`.
12. **Malformed Types Invariant**: Provide a string `"100"` instead of a number `100` for the trade `price`.

---

## 3. Test Runner Specification (`firestore.rules.test.ts`)

```typescript
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  setDoc,
  getDoc,
  addDoc,
  doc,
  collection,
} from 'firebase/firestore';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'test-gen-lang-client-0824252322',
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe('User Profiles Auth Enforcement', () => {
  it('prevents user-123 from writing user-abc profile', async () => {
    const context = testEnv.authenticatedContext('user-123');
    const db = context.firestore();
    const ref = doc(db, 'users', 'user-abc');
    await expect(
      setDoc(ref, {
        userId: 'user-abc',
        displayName: 'Attacker',
        totalDeposits: 5000000,
        cashBalance: 5000000,
        updatedAt: new Date(),
      })
    ).rejects.toThrow();
  });

  it('prevents user-123 from storing negative deposits', async () => {
    const context = testEnv.authenticatedContext('user-123');
    const db = context.firestore();
    const ref = doc(db, 'users', 'user-123');
    await expect(
      setDoc(ref, {
        userId: 'user-123',
        totalDeposits: -1000,
        cashBalance: 500,
        updatedAt: new Date(),
      })
    ).rejects.toThrow();
  });
});

describe('Stock Trades Security Enforcement', () => {
  it('prevents user-123 from creating a trade for user-abc', async () => {
    const context = testEnv.authenticatedContext('user-123');
    const db = context.firestore();
    const ref = doc(db, 'trades', 'some-trade-id');
    await expect(
      setDoc(ref, {
        userId: 'user-abc',
        ticker: '005930',
        companyName: 'Samsung Electronics',
        type: 'BUY',
        quantity: 10,
        price: 70000,
        date: new Date(),
        reason: 'Valid trade but spoofed ownership',
        createdAt: new Date(),
      })
    ).rejects.toThrow();
  });

  it('prevents negative quantity or price', async () => {
    const context = testEnv.authenticatedContext('user-123');
    const db = context.firestore();
    const ref = doc(db, 'trades', 'malicious-trade');
    await expect(
      setDoc(ref, {
        userId: 'user-123',
        ticker: '005930',
        companyName: 'Samsung Electronics',
        type: 'BUY',
        quantity: -10,
        price: 70000,
        date: new Date(),
        reason: 'Negative buy',
        createdAt: new Date(),
      })
    ).rejects.toThrow();
  });

  it('blocks colossal reason text to guard from Denial of Wallet', async () => {
    const context = testEnv.authenticatedContext('user-123');
    const db = context.firestore();
    const ref = doc(db, 'trades', 'giant-text');
    await expect(
      setDoc(ref, {
        userId: 'user-123',
        ticker: 'AAPL',
        companyName: 'Apple Inc.',
        type: 'BUY',
        quantity: 5,
        price: 180,
        date: new Date(),
        reason: 'a'.repeat(501), // over limit
        createdAt: new Date(),
      })
    ).rejects.toThrow();
  });
});
