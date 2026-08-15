# Refactor Notes: Membership & Payment Extraction

## Responsibilities

### MembershipService
- Owns cohesive membership business rules.
- `getActiveMembership`: Finds a user's current active membership by checking status and endDate.
- `createMembership`: Creates a new membership when a plan is subscribed to.
- `cancelMembership`: Cancels a membership, used primarily when a payment is refunded.
- `checkCredits`: Verifies if a membership has enough credits, honoring the `UNLIMITED_CREDITS` (999) rule.
- `consumeCredits`: Deducts credits from a membership, honoring the `UNLIMITED_CREDITS` (999) rule.
- `refundCredits`: Restores credits to a membership, honoring the `UNLIMITED_CREDITS` (999) rule.

### PaymentService
- Handles payment processing and refunds.
- `createPayment`: Records a new payment.
- `markPaid`: Updates payment status to paid.
- `refundPayment`: Handles the refund flow. Crucially, it updates the payment status and calls `MembershipService.cancelMembership` to preserve existing behavior.

## Credit Handling & Unlimited Credits
- Credits are deducted and refunded via `MembershipService.consumeCredits` and `MembershipService.refundCredits`.
- The system uses `UNLIMITED_CREDITS = 999` to denote unlimited plans.
- We reused the existing constant exported from `src/server/routers/bookings.ts` instead of creating a competing constants module.
- If a membership has >= 999 credits, deductions and refunds are completely bypassed to preserve unlimited status indefinitely.

## Transactions Introduced
- **Plan Subscription**: `src/server/routers/plans.ts` now uses a Drizzle transaction to atomically `MembershipService.createMembership` and `PaymentService.createPayment`.
- **Payment Refunds**: `src/server/routers/payments.ts` now uses a Drizzle transaction to atomically execute `PaymentService.refundPayment`, which refunds the payment and cancels the associated membership in one go.

## Behavior Preserved
- Waitlist and Booking logic in `bookings.ts` and `reschedules.ts` remains intact, per instructions not to refactor `BookingService` or `WaitlistService`.
- Refunding a payment successfully cancels the user's membership.
- Unlimited credits (`999`) never decrease.
- The known bug where rescheduling does not promote waitlisted users remains as-is, preserving the baseline behavior.

## Remaining Integration Dependencies
- `bookings.ts` and `reschedules.ts` have not yet been fully refactored to use `MembershipService` for credit deductions. They contain inline logic. This is an explicit decision to abide by the "Do NOT refactor BookingService" constraint.
- Constants like `UNLIMITED_CREDITS` are still imported from routers (`bookings.ts`). A dedicated constants module could be considered in a future phase.
