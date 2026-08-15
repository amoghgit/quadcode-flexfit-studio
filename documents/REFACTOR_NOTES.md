# FlexFit Studio — Phase 1 Refactoring Notes

## Overview

This document consolidates the architectural refactoring work performed across the BookingService and WaitlistService phases of FlexFit Studio.

The goal of Phase 1 was to restructure the existing application into a more maintainable service-oriented architecture while preserving existing application behavior and documenting known defects.

---

# Part A — Booking & Architecture Refactor


## Overview
This document tracks decisions, extractions, and behavior preservation metrics for the Phase 1 architectural refactor of FlexFit Studio's booking domain.

## Milestones Completed

### Milestone 1: Baseline Preservation & Test Infrastructure
*   **Action**: Added Vitest and configured dynamic SQLite in-memory databases per test process to fix `SQLITE_BUSY` locking errors.
*   **Action**: Created `tests/bookings.test.ts` and `tests/reschedules.test.ts` to characterize existing logic before making any code changes.
*   **Result**: Established a 5-test baseline that passes consistently, providing a safety net for upcoming extractions.

### Milestone 2: Centralizing Business Constants
*   **Action**: Created `src/lib/constants.ts`.
*   **Action**: Extracted hard-coded business rules across routers:
    *   `FREE_CANCELLATION_HOURS = 12`
    *   `CORPORATE_FREE_CANCELLATION_HOURS = 24`
    *   `FREE_RESCHEDULE_HOURS = 4`
    *   `UNLIMITED_CREDITS = 999`
*   **Result**: All magic numbers eliminated from `bookings.ts`, `reschedules.ts`, and `corporate-bookings.ts` without breaking tests.

### Milestone 3: Strengthen Regression Coverage
*   **Action**: Expanded regression tests from 5 to 13 tests to fully characterize all business logic paths:
    *   Insufficient credits rejection.
    *   No active membership rejection.
    *   Duplicate booking prevention.
    *   Unlimited membership behaviors (no credit deduction).
    *   Out-of-window cancellation (credit forfeiture).
    *   Trainer cancellation on behalf of member.
    *   Out-of-window reschedule rejection.
    *   Class-type mismatch during reschedule.
*   **Result**: Achieved high confidence that current constraints and behaviors are well-documented by automated tests.

### Milestone 4-6: Service Layer Extraction & Atomicity
*   **Action**: Created `BookingService` (`src/server/services/BookingService.ts`) and migrated the complex business logic out of the tRPC routers for:
    *   `bookClass`
    *   `cancelBooking`
    *   `rescheduleBooking`
*   **Action**: Thinned `bookings.ts` and `reschedules.ts` to be pure delegators to the new service layer for those specific mutations. Query operations and simple read/writes (like `markAttended`) remain in the routers.
*   **Action**: Added proper `db.transaction()` boundaries around the multi-step mutations to guarantee atomicity. This improves data safety if a crash occurs mid-mutation. This slightly changes failure semantics to be *more* rigid (preventing partial updates), which is a desired safety enhancement explicitly acknowledged in the constraints.
*   **Result**: All 13 tests remain green.

## Known Bugs Preserved
As mandated by the prompt constraints, we deliberately preserved known bugs from `BASELINE.md` rather than silently fixing them:

1.  **Reschedule Waitlist Bug**: When a member reschedules out of a full class, the oldest waitlisted member on the original class is NOT promoted.
    *   *Where*: `BookingService.rescheduleBooking()`
    *   *Test*: Explicitly tested and expected to fail promotion in `tests/reschedules.test.ts` (`it("exhibits KNOWN BUG: rescheduling does NOT promote waitlisted user for original class")`).

## Out of Scope (Untouched)
*   `MembershipService` and `PaymentService` domains.
*   `WaitlistService` (aside from the inline logic currently in booking functions).
*   `corporate-bookings` database schema and complex logic (handled by another team member). Note: The corporate constants were centralized to `constants.ts` but the router's logic structure was otherwise untouched.

---

# Part B — Waitlist Service Refactor


## Date
2026-08-15

## Branch
`refactor/waitlist-service`

---

## 1. Previous Duplicated Waitlist Implementations

Waitlist promotion logic was duplicated in two separate router files with nearly identical structure:

### Standard Bookings GÇö `src/server/routers/bookings.ts` (cancel mutation)
- **Location**: Lines 213GÇô251 (before refactor)
- **Algorithm**:
  1. When a `"booked"` booking is cancelled, find the oldest `"waitlisted"` booking for the same class (ordered by `bookedAt` ASC).
  2. Update its status to `"booked"` and set `creditsUsed` to the class's `creditCost`.
  3. If the promoted booking has a `membershipId`, deduct `creditCost` from the membership's `creditsRemaining`, clamped to 0 via `Math.max(0, ...)`.
  4. Skip deduction for unlimited memberships (`creditsRemaining >= 999`).

### Corporate Bookings GÇö `src/server/routers/corporate-bookings.ts` (cancel mutation)
- **Location**: Lines 225GÇô261 (before refactor)
- **Algorithm**: Same structure, but:
  - Operates on `corporate_bookings` table instead of `bookings`.
  - Deducts from company `creditPoolBalance` instead of membership `creditsRemaining`.
  - Credit deduction is conditional: only occurs if `creditPoolBalance >= creditCost` (a guard not present in the standard version).

### Missing from Reschedules GÇö `src/server/routers/reschedules.ts`
- The reschedule mutation cancels the original booking but **does not perform any waitlist promotion**. This is a **known bug** (see Section 6).

---

## 2. New WaitlistService

### Location
`src/server/services/WaitlistService.ts`

### Interface
```typescript
WaitlistService.promoteNextFromWaitlist(tx, classId, creditCost)
  GåÆ Promise<{ promoted: boolean; bookingId?: number }>

WaitlistService.promoteNextCorporateFromWaitlist(tx, classId, creditCost)
  GåÆ Promise<{ promoted: boolean; bookingId?: number }>
```

### Design Decisions
- **Two methods, one service**: Standard and corporate promotion target different tables (`bookings` vs `corporateBookings`) and different credit sources (membership vs company pool) with subtly different deduction logic. A single generic method would require fragile table/column discrimination parameters.
- **Transaction-compatible `tx` parameter**: Accepts `typeof import("@/db").db`, which works with both the raw db instance and a Drizzle transaction context since they share the same query interface.
- **No new constants**: The service uses the existing `999` sentinel for unlimited credits internally. It does not import from or duplicate constants in other files.
- **Return value**: Returns `{ promoted, bookingId }` so callers can optionally act on the result (e.g., send notifications).

---

## 3. Why the Extraction Preserves Behavior

Each service method was extracted by copying the exact inline implementation from the respective router and converting the `ctx.db` references to the `tx` parameter. Specifically:

| Aspect | Standard (bookings.ts) | Corporate (corporate-bookings.ts) | Service Method |
|---|---|---|---|
| Waitlist query | `bookings` table, `status = "waitlisted"`, `orderBy(asc(bookedAt))` | `corporateBookings` table, same filters and ordering | Identical per method |
| Status update | `status: "booked"`, `creditsUsed: creditCost` | Same | Identical |
| Credit deduction | `Math.max(0, remaining - cost)`, skip if `>= 999` | `Math.max(0, balance - cost)`, only if `balance >= cost` | Preserved per method |
| Empty waitlist | No-op | No-op | Returns `{ promoted: false }` |
| No membershipId | Skip deduction | N/A (always has companyId) | Preserved |

No behavioral changes were introduced. The router `cancel` mutations now delegate to the service with the same arguments they previously used inline.

---

## 4. Transaction Compatibility

The `tx` parameter accepts the Drizzle database client type. Because `drizzle-orm/libsql`'s `drizzle()` return type is the same interface used within `db.transaction(async (tx) => { ... })`, callers can:

1. Pass `ctx.db` directly (current behavior GÇö no transaction wrapping).
2. Wrap multiple operations in a transaction and pass `tx` to the service:
   ```typescript
   await ctx.db.transaction(async (tx) => {
     // cancel booking within tx...
     await WaitlistService.promoteNextFromWaitlist(tx, classId, creditCost);
   });
   ```

Currently, neither router wraps cancellation in a transaction (this is a pre-existing code smell documented in BASELINE.md Section 8). The service is designed to be compatible when transactions are eventually added.

---

## 5. Files Changed

| File | Change |
|---|---|
| `src/server/services/WaitlistService.ts` | **NEW** GÇö Centralized waitlist promotion service |
| `src/server/routers/bookings.ts` | Replaced inline promotion (L213GÇô251) with `WaitlistService.promoteNextFromWaitlist()` call |
| `src/server/routers/corporate-bookings.ts` | Replaced inline promotion (L225GÇô261) with `WaitlistService.promoteNextCorporateFromWaitlist()` call |
| `tests/waitlist.test.ts` | **NEW** GÇö 12 test cases covering all waitlist edge cases |
| `documents/REFACTOR_NOTES.md` | **NEW** GÇö This document |

---

## 6. Known Rescheduling Bug (PRESERVED)

**Bug**: When a user reschedules a booking (`reschedules.ts`), the original booking is cancelled, but waitlist promotion logic is completely missing. A spot opens up that should have been filled by a waitlisted user but is not.

**Status**: Intentionally preserved. The `WaitlistService` is available for the reschedules router to call, but it **must not** be added without explicit approval, as this would be a behavior change.

**Test coverage**:
- `tests/reschedules.test.ts`: "exhibits KNOWN BUG: rescheduling does NOT promote waitlisted user for original class"
- `tests/waitlist.test.ts`: "reschedule cancels original booking but waitlisted users remain waitlisted"

---

## 7. Remaining Dependencies

- **BookingService** (not yet extracted): The `bookings.ts` router's `cancel` mutation still contains inline business logic for refund calculation and authorization checks. The waitlist promotion is now delegated to `WaitlistService`, but other logic remains in the router.
- **CorporateBookingService** (not yet extracted): Same situation GÇö `corporate-bookings.ts` cancel mutation still has inline refund and authorization logic.
- **Constants**: `FREE_CANCELLATION_HOURS`, `UNLIMITED_CREDITS`, `CORPORATE_FREE_CANCELLATION_HOURS`, and `FREE_RESCHEDULE_HOURS` remain defined in their respective router files. A shared constants file is a future refactoring opportunity.
