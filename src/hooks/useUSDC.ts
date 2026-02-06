/**
 * useUSDC — Read real USDC balance & allowance from chain + approve/deposit/withdraw helpers.
 *
 * Uses wagmi's useReadContract for on-chain reads and
 * useWriteContract for approve() and transfer() transactions.
 */

import { useState, useCallback } from 'react'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, usePublicClient, useWalletClient } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import {
  USDC_SEPOLIA_ADDRESS,
  YELLOW_CUSTODY_ADDRESS,
  ERC20_ABI,
  USDC_DECIMALS,
} from '../config/contracts'

export function useUSDC() {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  // Manual tx tracking for deposit/withdraw
  const [depositTxHash, setDepositTxHash] = useState<`0x${string}` | undefined>()
  const [isDepositing, setIsDepositing] = useState(false)
  const [depositError, setDepositError] = useState<Error | null>(null)

  // ── Real on-chain USDC balance ──────────────────────────────────
  const {
    data: rawBalance,
    isLoading: isBalanceLoading,
    refetch: refetchBalance,
  } = useReadContract({
    address: USDC_SEPOLIA_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  // ── Current allowance to custody contract ───────────────────────
  const {
    data: rawAllowance,
    isLoading: isAllowanceLoading,
    refetch: refetchAllowance,
  } = useReadContract({
    address: USDC_SEPOLIA_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, YELLOW_CUSTODY_ADDRESS] : undefined,
    query: { enabled: !!address },
  })

  // ── Approve USDC to custody ─────────────────────────────────────
  const {
    writeContract,
    data: approveTxHash,
    isPending: isApproving,
    error: approveError,
    reset: resetApprove,
  } = useWriteContract()

  // ── Wait for approve tx confirmation ────────────────────────────
  const {
    isLoading: isWaitingForApproval,
    isSuccess: isApproveConfirmed,
  } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  })

  // ── Wait for deposit tx confirmation ────────────────────────────
  const {
    isLoading: isWaitingForDeposit,
    isSuccess: isDepositConfirmed,
  } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  })

  // ── Derived values ──────────────────────────────────────────────
  const balance = rawBalance != null
    ? parseFloat(formatUnits(rawBalance as bigint, USDC_DECIMALS))
    : 0

  const allowance = rawAllowance != null
    ? parseFloat(formatUnits(rawAllowance as bigint, USDC_DECIMALS))
    : 0

  /**
   * Approve `amount` USDC to the Yellow custody contract.
   */
  const approveUSDC = (amountInDollars: number) => {
    const units = parseUnits(amountInDollars.toString(), USDC_DECIMALS)

    writeContract({
      address: USDC_SEPOLIA_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [YELLOW_CUSTODY_ADDRESS, units],
    })
  }

  /**
   * TRANSFER: Send USDC from wallet → any address (settlement, custody, etc.)
   * Used at End Stream to settle only the spent amount to the streamer.
   * Returns the tx hash when confirmed.
   */
  const transferUSDC = useCallback(async (amountInDollars: number, toAddress: `0x${string}`): Promise<`0x${string}` | null> => {
    if (!walletClient || !publicClient || !address) {
      setDepositError(new Error('Wallet not connected'))
      return null
    }

    setIsDepositing(true)
    setDepositError(null)

    try {
      const units = parseUnits(amountInDollars.toString(), USDC_DECIMALS)

      console.log(`🔗 [ON-CHAIN] Transferring $${amountInDollars} USDC (settlement)...`)
      console.log(`🔗 [ON-CHAIN] From: ${address}`)
      console.log(`🔗 [ON-CHAIN] To: ${toAddress}`)
      console.log(`🔗 [ON-CHAIN] Amount: ${units.toString()} units (${amountInDollars} USDC)`)

      // Send the real transfer tx
      const hash = await walletClient.writeContract({
        address: USDC_SEPOLIA_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [toAddress, units],
      })

      console.log(`📝 [ON-CHAIN] Settlement tx submitted: ${hash}`)
      console.log(`🔍 [ON-CHAIN] View on Etherscan: https://sepolia.etherscan.io/tx/${hash}`)
      setDepositTxHash(hash)

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      console.log(`✅ [ON-CHAIN] Settlement CONFIRMED in block ${receipt.blockNumber}`)
      console.log(`💸 [ON-CHAIN] $${amountInDollars} USDC sent to streamer`)

      // Refetch balances after settlement
      refetchBalance()
      refetchAllowance()

      setIsDepositing(false)
      return hash
    } catch (err) {
      console.error('❌ [ON-CHAIN] Settlement transfer failed:', err)
      setDepositError(err instanceof Error ? err : new Error('Settlement failed'))
      setIsDepositing(false)
      return null
    }
  }, [walletClient, publicClient, address, refetchBalance, refetchAllowance])

  /** Refresh both balance and allowance from chain */
  const refetch = () => {
    refetchBalance()
    refetchAllowance()
  }

  return {
    /** USDC balance in dollars (e.g. 42.5 means 42.5 USDC) */
    balance,
    /** Current allowance to Yellow custody in dollars */
    allowance,
    /** Whether balance is being fetched */
    isBalanceLoading,
    /** Whether allowance is being fetched */
    isAllowanceLoading,
    /** Whether an approve tx is being signed */
    isApproving,
    /** Whether we're waiting for the approve tx to confirm */
    isWaitingForApproval,
    /** Whether the approve tx has been confirmed */
    isApproveConfirmed,
    /** Approve error (user rejected, etc.) */
    approveError,
    /** Approve USDC spending to custody contract */
    approveUSDC,
    /** Reset approve state */
    resetApprove,

    /** Transfer USDC to any address (used for settlement) */
    transferUSDC,
    /** Whether a transfer tx is in progress */
    isDepositing,
    /** Whether we're waiting for deposit confirmation */
    isWaitingForDeposit,
    /** Whether deposit was confirmed */
    isDepositConfirmed,
    /** Deposit error */
    depositError,
    /** Deposit tx hash */
    depositTxHash,

    /** Refetch balance + allowance from chain */
    refetch,
    /** The approve tx hash (for explorer links) */
    approveTxHash,
  }
}
