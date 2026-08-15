# Refactoring Notes: Phase 1 (Booking & Architecture)

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
