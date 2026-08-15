# Baseline Application Architecture & Analysis

## 1. Application Architecture

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **API/Communication**: tRPC
- **Database ORM**: Drizzle ORM
- **Database**: SQLite (local)
- **Styling**: Tailwind CSS

### Directory Structure
- `src/app`: Next.js App Router (pages, layouts, route handlers). Includes areas like `/admin`, `/dashboard`, `/login`, `/schedule`, `/trainer`, `/waitlist`.
- `src/components`: UI components (e.g., `NavBar.tsx`, `reschedule-modal.tsx`).
- `src/server/routers`: tRPC backend procedures grouping business logic (auth, admin, classes, bookings, corporate-bookings, reschedules, etc.).
- `src/db/schema.ts`: Single file containing all Drizzle ORM table definitions.
- `documents`: Documentation folder (where this file resides).

## 2. Feature Inventory

1. **Authentication**: User sessions, basic role management (`member`, `trainer`, `admin`).
2. **Member Dashboard**: Viewing active memberships, past/upcoming bookings, credits remaining.
3. **Class Scheduling**: Listing classes, capacity management, trainer assignment.
4. **Bookings & Cancellations**: Booking classes using credits, enforcing capacity, handling cancellations with refund policies.
5. **Waitlists**: Automatic waitlisting when classes are full, and promotion when spots open up.
6. **Rescheduling**: Moving a booking to a different class of the same type.
7. **Memberships & Plans**: Subscribing to plans (standard and unlimited), tracking active periods and remaining credits.
8. **Payments**: Processing (mock) payments for memberships, admin refunds.
9. **Corporate Accounts**: Linking members to companies, managing company credit pools, corporate booking flows.
10. **Admin / Trainer Portal**: Dashboard stats, attendance tracking (check-ins), revenue reports, roster management, setting user roles, managing companies.

## 3. Business Rules

- **Cancellation Windows**: 
  - Standard Members: Free cancellation up to 12 hours before class (`FREE_CANCELLATION_HOURS = 12`).
  - Corporate Members: Free cancellation up to 24 hours before class (`CORPORATE_FREE_CANCELLATION_HOURS = 24`).
  - Cancelling after the window forfeits the credit but frees the spot.
- **Rescheduling**: Allowed up to 4 hours before the original class (`FREE_RESCHEDULE_HOURS = 4`). Transfers the existing credit usage (even if 0 for waitlisted) to the new booking.
- **Unlimited Credits**: Represented by a hardcoded value of `999` (`UNLIMITED_CREDITS`).
- **Waitlists**: If bookings >= capacity, status is set to `waitlisted` and 0 credits are deducted initially.
- **Waitlist Promotion**: When a confirmed booking is cancelled, the oldest waitlisted member is promoted, and their credits are deducted.
- **Refunds**: Admin refunding a payment instantly changes the associated membership status to `cancelled`.

## 4. Data Flows

**Standard Interaction Flow**:
1. **UI Component** calls a tRPC hook (e.g., `trpc.bookings.cancel.useMutation()`).
2. **tRPC Router** intercepts the request, validates the input using `zod`.
3. **Auth Middleware** (`protectedProcedure`, `staffProcedure`, `adminProcedure`) verifies user roles and session tokens.
4. **Business Logic** executes inside the router (e.g., checking cancellation windows, retrieving active memberships).
5. **Drizzle ORM** constructs and executes SQL queries against the SQLite database.
6. **Response** is returned back through tRPC to the client, mutating UI state.

## 5. Database Structure

The schema is defined in `src/db/schema.ts` and contains the following core tables:
- **Core**: `users`, `sessions`, `notifications`
- **Memberships & Finance**: `membership_plans`, `memberships`, `payments`
- **Scheduling**: `classes`, `trainer_availability`
- **Booking & Attendance**: `bookings`, `checkins`, `reschedules`
- **Corporate**: `companies`, `company_members`, `corporate_bookings`

**Relationships**:
- Users have one Role (`member`, `trainer`, `admin`).
- Bookings link `users`, `classes`, and `memberships`.
- Corporate Bookings link `users`, `classes`, and `companies`.
- Checkins link `users` and `bookings`.

## 6. Authorization Rules

- **Public**: Can view class schedules (`classes.list`, `classes.byId`) and membership plans.
- **Protected (Member)**: Can manage their own profile, view their bookings/payments, book classes, cancel their own bookings, and reschedule.
- **Staff (Trainer/Admin)**: Can create/update classes, check in members, view class rosters, lookup users, and view checkin counts.
- **Admin**: Can view global stats, class utilization, revenue reports, manage expiring memberships, refund payments, update user roles, and manage corporate accounts (top up credits, link/unlink members).

## 7. Edge Cases & Bugs Documented

- **Waitlist Promotion on Reschedule (BUG)**: When a user reschedules (`reschedules.ts`), their original booking is cancelled, but the waitlist promotion logic is completely missing. This leaves a spot open that should have been filled by a waitlisted user.
- **Corporate Checkins (BUG)**: When marking a corporate booking as attended (`corporate-bookings.ts`), a checkin record is created with a `null` bookingId (`bookingId: null`) instead of linking to the corporate booking ID.
- **Duplicate Booking Prevention**: The system correctly prevents double-booking a user for the same class by checking for existing active statuses.
- **Unlimited Credit Deduction Check**: The system correctly bypasses credit deduction if `creditsRemaining >= 999`.

## 8. Current Code Smells

- **Duplicated Business Logic**: Waitlist promotion logic is duplicated in `bookings.ts` and `corporate-bookings.ts`, and missed in `reschedules.ts`.
- **Database Schema Duplication**: `corporate_bookings` is essentially a clone of `bookings`. They could be unified with a nullable `companyId`.
- **Fat Routers / Mixed Responsibilities**: The tRPC routers (e.g., `bookings.ts`) contain dense business logic, database transactions, and authorization rules mixed together.
- **Hardcoded Magic Numbers**: `999` for unlimited credits.
- **Missing Database Transactions**: Complex mutations (like cancelling a booking, refunding credits, and promoting a waitlisted user) are performed as sequential SQL queries without a transaction. If one fails, the database is left in an inconsistent state.

## 9. Refactoring Opportunities

- **Service Layer**: Extract business logic (like "cancel booking" or "promote waitlist") from tRPC routers into a dedicated Service layer (`src/server/services/BookingService.ts`).
- **Database Transactions**: Wrap multi-step mutations in Drizzle transactions (`ctx.db.transaction(async (tx) => { ... })`).
- **Unified Bookings**: Merge `corporate_bookings` into `bookings` to DRY up the booking flows.
- **Constants File**: Move `FREE_CANCELLATION_HOURS`, `UNLIMITED_CREDITS`, etc., into a shared constants file.

## 10. Behavior That MUST NOT CHANGE

- The 12-hour, 24-hour, and 4-hour cancellation/reschedule windows.
- The meaning of `999` credits (unlimited).
- Database foreign key constraints and core schema relationships.
- User role semantics and authorization boundaries (Staff vs Admin vs Member).
- Automatic credit deduction and waitlist flow.
