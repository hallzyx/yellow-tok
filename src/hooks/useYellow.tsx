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
import { useAccount, useWalletClient, usePublicClient, useSwitchChain } from 'wagmi'
import YellowTokService from '../services/YellowTokService'
import type {
  SessionInfo,
  SendTipResult,
  CreateSessionResult,
  EndSessionResult,
  SpendingLimitCheck,
} from '../services/YellowTokService'
import { useUSDC } from './useUSDC'
import { USDC_CHAIN_ID } from '../config/chains'
import { USDC_BASE_ADDRESS } from '../config/contracts'

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
  /** Whether USDC is being deposited to Yellow Network */
  isDepositingToYellow: boolean
  /** Whether funds are being withdrawn from Yellow Network */
  isWithdrawingFromYellow: boolean
  /** Current deposit/withdraw step description */
  depositStep: string | null
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
  /** Deep cleanup: close orphan channels, drain custody, reset state */
  cleanupYellow: () => Promise<void>
  /** Whether a cleanup operation is in progress */
  isCleaning: boolean
  /** Clear the error state */
  clearError: () => void
}

// ─── Context ──────────────────────────────────────────────────────
const YellowContext = createContext<UseYellowReturn | null>(null)

// ─── Provider ─────────────────────────────────────────────────────
export function YellowProvider({ children }: { children: React.ReactNode }) {
  const { isConnected: isWalletConnected, address } = useAccount()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const { switchChainAsync } = useSwitchChain()

  // ── On-chain USDC data ──────────────────────────────────────────
  const usdc = useUSDC()

  // Reactive state
  const [isInitialized, setIsInitialized] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)
  const [isConnectedToYellow, setIsConnectedToYellow] = useState(false)
  const [isStreamActive, setIsStreamActive] = useState(false)
  const [isDepositingToYellow, setIsDepositingToYellow] = useState(false)
  const [isWithdrawingFromYellow, setIsWithdrawingFromYellow] = useState(false)
  const [depositStep, setDepositStep] = useState<string | null>(null)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isCleaning, setIsCleaning] = useState(false)

  // Singleton service ref (survives re-renders)
  const serviceRef = useRef<YellowTokService | null>(null)

  /** Get or create the singleton service instance */
  const getService = useCallback(() => {
    if (!serviceRef.current) {
      serviceRef.current = new YellowTokService({
        clearnodeUrl: import.meta.env.VITE_NITROLITE_WS_URL || 'wss://clearnet.yellow.com/ws',
        standardCommission: 10,
        partnerCommission: 3,
        defaultAsset: 'usdc',
        assetDecimals: 6,
      })
    }
    return serviceRef.current
  }, [])

  // ── Initialize: wallet → ClearNode ──────────────────────────────
  const initialize = useCallback(async (): Promise<boolean> => {
    if (isInitialized) return true
    if (isInitializing) return false
    if (!isWalletConnected || !address || !walletClient) {
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
      service.on('onAuthenticated', () => console.log('🔐 Yellow Network authenticated'))
      service.on('onConfigReady', () => console.log('⚙️ ClearNode config ready'))
      service.on('onDepositProgress', (evt: { step: number; message: string; complete?: boolean }) => {
        setDepositStep(evt.message)
        if (evt.complete) setIsDepositingToYellow(false)
      })
      service.on('onWithdrawProgress', (evt: { step: number; message: string; complete?: boolean }) => {
        setDepositStep(evt.message)
        if (evt.complete) setIsWithdrawingFromYellow(false)
      })
      service.on('onSessionCreated', () => setSession(service.getSessionInfo()))
      service.on('onTipSent', () => setSession(service.getSessionInfo()))
      service.on('onTipReceived', () => setSession(service.getSessionInfo()))
      service.on('onBalanceUpdate', () => setSession(service.getSessionInfo()))
      service.on('onSessionClosed', () => setSession(null))
      service.on('onError', (evt: { message: string }) => setError(evt.message))

      // Pass address + walletClient + publicClient (no window.ethereum needed)
      const result = await service.initialize(address, walletClient, publicClient)

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
  }, [isInitialized, isInitializing, isWalletConnected, address, walletClient, getService])

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
        // ══ Turn OFF → Close Yellow channel + withdraw remaining funds ══
        setIsWithdrawingFromYellow(true)
        setDepositStep('Closing channel and withdrawing...')

        try {
          // endStreamSession now handles close channel + withdraw internally
          await endSession()
          console.log('💰 Stream ended. Channel closed and funds withdrawn to wallet.')
        } catch (err) {
          console.error('❌ Settlement error:', err)
          setError(err instanceof Error ? err.message : 'Settlement failed')
        } finally {
          setIsWithdrawingFromYellow(false)
          setDepositStep(null)
        }

        // Refetch on-chain balance after withdrawal
        setTimeout(() => usdc.refetch(), 3000)
      } else {
        // ══ Turn ON → Initialize, deposit to Yellow, create session ══
        usdc.refetch()

        if (usdc.balance < depositAmount) {
          setError(
            `Insufficient USDC balance on Base. You have $${usdc.balance.toFixed(2)} USDC but need $${depositAmount.toFixed(2)}. Please reduce your spending limit or add more USDC to Base network.`
          )
          return
        }

        // Initialize Yellow Network connection if not ready
        const service = serviceRef.current
        const alreadyConnected = service?.connected ?? false

        let ready = alreadyConnected
        if (!ready) {
          ready = await initialize()
        }

        if (!ready) return

        const svc = getService()

        // Double-check balance before proceeding
        if (usdc.balance < depositAmount) {
          setError(
            `Cannot deposit $${depositAmount.toFixed(2)} USDC. Your balance: $${usdc.balance.toFixed(2)}. Please lower your spending limit.`
          )
          return
        }

        // Switch MetaMask to Base mainnet explicitly before any on-chain ops
        try {
          console.log('🔗 Switching wallet to Base mainnet...')
          await switchChainAsync({ chainId: USDC_CHAIN_ID })
        } catch (switchErr) {
          console.error('❌ Failed to switch to Base:', switchErr)
          setError('Please switch your wallet to Base network to continue.')
          return
        }

        // Deposit to Yellow Network on Base mainnet
        try {
          const chainId = USDC_CHAIN_ID // Base (8453)
          const tokenAddress = USDC_BASE_ADDRESS

          if (svc.isChainSupported(chainId)) {
            console.log(`💰 [YELLOW] Depositing ${depositAmount} USDC to Yellow Network on Base...`)
            setIsDepositingToYellow(true)
            setDepositStep('Starting deposit...')

            await svc.depositAndOpenChannel(depositAmount, chainId, tokenAddress)
            setIsDepositingToYellow(false)
            setDepositStep(null)
          } else {
            const supported = svc.getSupportedChainIds()
            console.warn(
              `⚠️ Base chain (${chainId}) not in ClearNode config. Supported: ${supported.join(', ')}`
            )
            console.log('💡 Tips will be tracked locally until Base is confirmed by ClearNode.')
          }
        } catch (depositErr) {
          setIsDepositingToYellow(false)
          setDepositStep(null)
          console.error('❌ Deposit failed:', depositErr)
          setError(
            depositErr instanceof Error ? depositErr.message : 'Deposit to Yellow Network failed'
          )
          return
        }

        // Create the session (local tracking + ledger balance query)
        const result = await createSession(streamerAddress, depositAmount)
        if (result?.success) {
          setIsStreamActive(true)
        }
      }
    },
    [isStreamActive, initialize, createSession, endSession, usdc, getService, switchChainAsync]
  )

  // ── Deep cleanup ────────────────────────────────────────────────
  const cleanupYellow = useCallback(async () => {
    const service = serviceRef.current
    if (!service || !service.connected) {
      // Need to initialize first
      const ok = await initialize()
      if (!ok) {
        setError('Could not connect to Yellow Network for cleanup')
        return
      }
    }

    setIsCleaning(true)
    setError(null)
    setDepositStep('🧹 Starting deep cleanup...')

    try {
      const svc = getService()

      // Switch to Base
      try {
        await switchChainAsync({ chainId: USDC_CHAIN_ID })
      } catch {
        // may already be on Base
      }

      const result = await svc.deepCleanup(USDC_CHAIN_ID, USDC_BASE_ADDRESS)

      const summary = [
        `Channels closed: ${result.channelsClosed.length}`,
        `Custody drained: ${result.custodyDrained?.amount ?? '0'} USDC`,
        result.errors.length > 0 ? `Warnings: ${result.errors.join('; ')}` : null,
      ].filter(Boolean).join(' | ')

      console.log('🧹 Cleanup complete:', summary)
      setDepositStep(null)

      // Reset stream state
      setIsStreamActive(false)
      setSession(null)

      // Refetch wallet balance
      setTimeout(() => usdc.refetch(), 3000)
    } catch (err) {
      console.error('❌ Cleanup failed:', err)
      setError(err instanceof Error ? err.message : 'Cleanup failed')
      setDepositStep(null)
    } finally {
      setIsCleaning(false)
    }
  }, [initialize, getService, switchChainAsync, usdc])

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
      setIsDepositingToYellow(false)
      setIsWithdrawingFromYellow(false)
      setDepositStep(null)
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
        isDepositingToYellow,
        isWithdrawingFromYellow,
        depositStep,
        session,
        error,

        // USDC on-chain
        usdcBalance: usdc.balance,
        usdcAllowance: usdc.allowance,
        isUsdcLoading: usdc.isBalanceLoading || usdc.isAllowanceLoading,
        isApproving: usdc.isApproving,
        isWaitingForApproval: usdc.isWaitingForApproval,
        isApproveConfirmed: usdc.isApproveConfirmed,
        isSettling: usdc.isDepositing || isWithdrawingFromYellow,
        isWaitingForSettlement: usdc.isWaitingForDeposit || isWithdrawingFromYellow,

        initialize,
        approveUSDC: usdc.approveUSDC,
        refetchUSDC: usdc.refetch,
        createSession,
        sendTip,
        endSession,
        toggleStream,
        checkSpendingLimit,
        cleanupYellow,
        isCleaning,
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
