/**
 * DSH Plugin: OpenCode Go Quota Monitor
 * TypeScript declarations for host-side plugin
 */

import type { Context } from '@deepseek-ai/cordis'

export declare const name: string
export declare const inject: string[]

/**
 * Main plugin apply function
 * @param ctx - Plugin context
 */
export declare function apply(ctx: Context): void

/** One quota window from the OpenCode Go usage API. */
export interface QuotaWindow {
  /** Remaining percent (100 - percent used), 0..100 */
  percentRemaining: number
  /** ISO timestamp of the window reset. */
  resetsAt: string
}

export interface QuotaData {
  plan: string
  status: 'active' | 'no-token' | 'api-error'
  windows: {
    rolling: QuotaWindow
    weekly: QuotaWindow
    monthly: QuotaWindow
  } | null
  lastUpdated: string
  error?: string
}

export default {
  name: typeof name,
  inject: typeof inject,
  apply: typeof apply
}
