import { sepolia, base } from 'wagmi/chains'

// ENS resolution stays on Sepolia testnet
export const ENS_CHAIN = sepolia
export const ENS_CHAIN_ID = sepolia.id

// USDC transactions happen on Base mainnet (supported by Yellow Network)
export const USDC_CHAIN = base
export const USDC_CHAIN_ID = base.id

// Primary chain for wallet connection (Base for USDC)
export const PRIMARY_CHAIN = base
