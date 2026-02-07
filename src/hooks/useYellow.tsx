/**
 * useYellow — React hook + context for Yellow Network integration.
 *
 * Wraps YellowTokService as a singleton, exposes reactive state,
 * and provides methods that components can call to interact with
 * Yellow state channels (create sessions, send tips, etc.).
 */

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import YellowTokService from '../services/YellowTokService'
import type {
  SessionInfo,
  SendTipResult,
  CreateSessionResult,
  EndSessionResult,
  SpendingLimitCheck,
} from '../services/YellowTokService'
import { useUSDC } from './useUSDC'

// ─── Window type extension for ethereum provider ──────────────────
declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>
    }
  }
}

// ─── Context value shape ──────────────────────────────────────────
export interface UseYellowReturn {
  /** Whether the service has been initialized and connected to ClearNode */
  isInitialized: boolean
  /** Whether initialization is currently in progress */
  isInitializing: boolean
  /** Whether the WebSocket to Yellow ClearNode is active */
  isConnectedToYellow: boolean
  /** Whether the streaming session is actively running */
  isStreamActive: boolean
  /** Current active streaming session info (null if none) */
  session: SessionInfo | null
  /** Last error message from Yellow Network operations */
  error: string | null

  // ── USDC on-chain data ──────────────────────────────────────────
  /** Real USDC balance from wallet (on-chain) */
  usdcBalance: number
  /** Current allowance approved to Yellow custody */
  usdcAllowance: number
  /** Whether USDC balance is loading */
  isUsdcLoading: boolean
  /** Whether an approve tx is pending signature */
  isApproving: boolean
  /** Whether waiting for approve tx to confirm on-chain */
  isWaitingForApproval: boolean
  /** Whether the approve was confirmed on-chain */
  isApproveConfirmed: boolean
  /** Whether a settlement transfer is in progress (End Stream) */
  isSettling: boolean
  /** Whether waiting for settlement tx to confirm on-chain */
  isWaitingForSettlement: boolean

  /** Connect wallet + open WebSocket to ClearNode */
  initialize: () => Promise<boolean>
  /** Approve USDC spending to Yellow custody (1 on-chain tx) */
  approveUSDC: (amount: number) => void
  /** Refresh on-chain balances */
  refetchUSDC: () => void
  /** Open a state channel with a streamer */
  createSession: (
    streamerAddress: string,
    depositAmount: number,
    isPartner?: boolean
  ) => Promise<CreateSessionResult | null>
  /** Send a tip off-chain through the state channel ($0 gas) */
  sendTip: (
    amount: number,
    streamerAddress: string,
    message?: string
  ) => Promise<SendTipResult | null>
  /** Close the session and settle everything on-chain (1 tx) */
  endSession: () => Promise<EndSessionResult | null>
  /** Toggle stream on/off — controls the Yellow Network session lifecycle */
  toggleStream: (streamerAddress: string, depositAmount: number) => Promise<void>
  /** Check if a tip would exceed the spending limit */
  checkSpendingLimit: (
    tipAmount: number,
    spendingLimit: number
  ) => SpendingLimitCheck
  /** Clear the error state */
  clearError: () => void
}

// ─── Context ──────────────────────────────────────────────────────
const YellowContext = createContext<UseYellowReturn | null>(null)

// ─── Provider ─────────────────────────────────────────────────────
export function YellowProvider({ children }: { children: React.ReactNode }) {
  const { isConnected: isWalletConnected } = useAccount()
  const { data: walletClient } = useWalletClient()

  // ── On-chain USDC data ──────────────────────────────────────────
  const usdc = useUSDC()

  // Reactive state
  const [isInitialized, setIsInitialized] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)
  const [isConnectedToYellow, setIsConnectedToYellow] = useState(false)
  const [isStreamActive, setIsStreamActive] = useState(false)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Singleton service ref (survives re-renders)
  const serviceRef = useRef<YellowTokService | null>(null)

  /** Get or create the singleton service instance */
  const getService = useCallback(() => {
    if (!serviceRef.current) {
      serviceRef.current = new YellowTokService({
        clearnodeUrl: 'wss://clearnet-sandbox.yellow.com/ws',
        standardCommission: 10,
        partnerCommission: 3,
        defaultAsset: 'ytest.usd',
        assetDecimals: 6,
      })
    }
    return serviceRef.current
  }, [])

  // ── Initialize: wallet → ClearNode ──────────────────────────────
  const initialize = useCallback(async (): Promise<boolean> => {
    if (isInitialized) return true
    if (isInitializing) return false
    if (!isWalletConnected || !window.ethereum || !walletClient) {
      setError('Wallet not connected or wallet client not ready.')
      return false
    }

    setIsInitializing(true)
    setError(null)

    try {
      const service = getService()

      // Wire up event handlers → reactive state
      service.on('onConnected', () => setIsConnectedToYellow(true))
      service.on('onDisconnected', () => setIsConnectedToYellow(false))
      service.on('onSessionCreated', () => setSession(service.getSessionInfo()))
      service.on('onTipSent', () => setSession(service.getSessionInfo()))
      service.on('onTipReceived', () => setSession(service.getSessionInfo()))
      service.on('onBalanceUpdate', () => setSession(service.getSessionInfo()))
      service.on('onSessionClosed', () => setSession(null))
      service.on('onError', (evt: { message: string }) => setError(evt.message))

      // Pass walletClient for EIP-712 signing during Nitrolite auth
      const result = await service.initialize(window.ethereum, walletClient)

      if (result.success) {
        setIsInitialized(true)
        return true
      }

      setError(result.error ?? 'Failed to initialize Yellow Network')
      return false
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Initialization failed')
      return false
    } finally {
      setIsInitializing(false)
    }
  }, [isInitialized, isInitializing, isWalletConnected, walletClient, getService])

  // ── Create a streaming session (state channel) ──────────────────
  const createSession = useCallback(
    async (
      streamerAddress: string,
      depositAmount: number,
      isPartner = false
    ): Promise<CreateSessionResult | null> => {
      const service = serviceRef.current
      // Use service.connected (mutable property) instead of React state
      // to avoid stale closure when called right after initialize()
      if (!service || !service.connected) {
        setError('Yellow Network not initialized')
        return null
      }
      setError(null)

      try {
        const result = await service.createStreamSession(
          streamerAddress,
          depositAmount,
          { isPartner }
        )
        setSession(service.getSessionInfo())
        return result
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to create session'
        )
        return null
      }
    },
    [] // no React state deps — reads mutable ref directly
  )

  // ── Send tip off-chain ($0 gas, instant) ────────────────────────
  const sendTip = useCallback(
    async (
      amount: number,
      streamerAddress: string,
      message = ''
    ): Promise<SendTipResult | null> => {
      const service = serviceRef.current
      if (!service || !service.connected) {
        setError('Yellow Network not initialized')
        return null
      }
      setError(null)

      try {
        const result = await service.sendTip(amount, streamerAddress, message)
        setSession(service.getSessionInfo())
        return result
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send tip')
        return null
      }
    },
    [] // no React state deps — reads mutable ref directly
  )

  // ── End session & settle on-chain ───────────────────────────────
  const endSession = useCallback(async (): Promise<EndSessionResult | null> => {
    const service = serviceRef.current
    if (!service) return null

    try {
      const result = await service.endStreamSession()
      setSession(null)
      setIsStreamActive(false)
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end session')
      return null
    }
  }, [])

  // ── Toggle stream ON / OFF ──────────────────────────────────────
  const toggleStream = useCallback(
    async (streamerAddress: string, depositAmount: number) => {
      if (isStreamActive) {
        // ══ Turn OFF → SETTLE on-chain: transfer ONLY the spent amount ══
        const service = serviceRef.current
        const sessionInfo = service?.getSessionInfo()
        const spentAmount = sessionInfo?.spent ?? 0
        const streamer = sessionInfo?.streamer as `0x${string}` | undefined

        // End the off-chain session first
        await endSession()

        // Now do the REAL on-chain settlement
        if (spentAmount > 0 && streamer) {
          console.log(`\n🏛️ ═══ SETTLEMENT ═════════════════════════════════════`)
          console.log(`💸 Settling $${spentAmount.toFixed(2)} USDC to streamer ${streamer}`)
          console.log(`💰 You keep $${(depositAmount - spentAmount).toFixed(2)} USDC (unused budget)`)

          const txHash = await usdc.transferUSDC(spentAmount, streamer)

          if (txHash) {
            console.log(`✅ Settlement complete! $${spentAmount.toFixed(2)} USDC sent to streamer on-chain.`)
            console.log(`💰 Your wallet now has: ~$${(usdc.balance - spentAmount).toFixed(2)} USDC`)
          } else {
            console.error('❌ Settlement transfer failed! Tips were off-chain only.')
            setError('Settlement failed. The streamer did not receive the tips on-chain.')
          }
        } else {
          console.log('💰 No tips were sent — nothing to settle on-chain. Your balance is unchanged.')
        }

        // Refetch on-chain balance after settlement
        setTimeout(() => usdc.refetch(), 2000)
      } else {
        // ══ Turn ON → Verify balance, connect, create session ══
        // State channels DON'T move funds upfront — only at settlement!
        usdc.refetch()

        if (usdc.balance < depositAmount) {
          setError(
            `Insufficient USDC balance. You have $${usdc.balance.toFixed(2)} USDC but need $${depositAmount.toFixed(2)}.`
          )
          return
        }

        console.log(`💰 [USDC] Wallet balance: $${usdc.balance.toFixed(2)} USDC (on-chain, real)`)
        console.log(`🔒 [SESSION] Locking $${depositAmount.toFixed(2)} USDC budget for this session`)
        console.log(`⚡ No upfront transfer — funds move ONLY at settlement (End Stream)`)

        // Turn ON → initialize if needed, then create session
        const service = serviceRef.current
        const alreadyConnected = service?.connected ?? false

        let ready = alreadyConnected
        if (!ready) {
          ready = await initialize()
        }

        if (ready) {
          const result = await createSession(streamerAddress, depositAmount)
          if (result?.success) {
            setIsStreamActive(true)
          }
        }
      }
    },
    [isStreamActive, initialize, createSession, endSession, usdc]
  )

  // ── Check spending limit ────────────────────────────────────────
  const checkSpendingLimit = useCallback(
    (tipAmount: number, spendingLimit: number): SpendingLimitCheck => {
      const service = serviceRef.current
      if (!service) {
        return {
          allowed: false,
          reason: 'Service not available',
          percentUsed: 0,
        }
      }
      return service.checkSpendingLimit(tipAmount, spendingLimit)
    },
    []
  )

  /** Clear error */
  const clearError = useCallback(() => setError(null), [])

  // ── Cleanup on unmount ──────────────────────────────────────────
  useEffect(() => {
    return () => {
      serviceRef.current?.disconnect()
      serviceRef.current = null
    }
  }, [])

  // ── Reset everything when wallet disconnects ────────────────────
  useEffect(() => {
    if (!isWalletConnected && isInitialized) {
      serviceRef.current?.disconnect()
      serviceRef.current = null
      setIsInitialized(false)
      setIsConnectedToYellow(false)
      setIsStreamActive(false)
      setSession(null)
      setError(null)
    }
  }, [isWalletConnected, isInitialized])

  // ── Provide context ─────────────────────────────────────────────
  return (
    <YellowContext.Provider
      value={{
        isInitialized,
        isInitializing,
        isConnectedToYellow,
        isStreamActive,
        session,
        error,

        // USDC on-chain
        usdcBalance: usdc.balance,
        usdcAllowance: usdc.allowance,
        isUsdcLoading: usdc.isBalanceLoading || usdc.isAllowanceLoading,
        isApproving: usdc.isApproving,
        isWaitingForApproval: usdc.isWaitingForApproval,
        isApproveConfirmed: usdc.isApproveConfirmed,
        isSettling: usdc.isDepositing,
        isWaitingForSettlement: usdc.isWaitingForDeposit,

        initialize,
        approveUSDC: usdc.approveUSDC,
        refetchUSDC: usdc.refetch,
        createSession,
        sendTip,
        endSession,
        toggleStream,
        checkSpendingLimit,
        clearError,
      }}
    >
      {children}
    </YellowContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────
/**
 * Access Yellow Network functionality from any component.
 * Must be used within a `<YellowProvider>`.
 */
export function useYellow(): UseYellowReturn {
  const context = useContext(YellowContext)
  if (!context) {
    throw new Error('useYellow must be used within a <YellowProvider>')
  }
  return context
}
