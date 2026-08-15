/**
 * Shared business constants for FlexFit Studio.
 *
 * These values encode critical business rules. Changing them changes
 * user-facing behavior. Every constant here was previously defined
 * inline in one or more tRPC routers; centralising them ensures a
 * single source of truth.
 */

/**
 * Standard members may cancel free of charge up to this many hours
 * before the class starts. Cancelling later still frees the spot but
 * forfeits the credit.
 */
export const FREE_CANCELLATION_HOURS = 12;

/**
 * Corporate members may cancel free of charge up to this many hours
 * before the class starts.
 */
export const CORPORATE_FREE_CANCELLATION_HOURS = 24;

/**
 * Members may reschedule free of charge up to this many hours before
 * the original class starts.
 */
export const FREE_RESCHEDULE_HOURS = 4;

/**
 * Plans with this many credits (or more) are treated as unlimited and
 * never decrement.
 */
export const UNLIMITED_CREDITS = 999;
