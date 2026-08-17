/**
 * DSH Plugin: OpenCode Go Quota Monitor
 * TypeScript declarations for client-side plugin
 */

import type { ReactNode } from 'react'

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

/** The quota status dot rendered left of the model selector. */
export declare function QuotaDot(props: object): ReactNode

export default QuotaDot
