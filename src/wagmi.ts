import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { PRIMARY_CHAIN, ENS_CHAIN } from './config/chains'

// Use dedicated Alchemy RPC for Base mainnet (better performance + reliability)
const BASE_RPC_URL = import.meta.env.VITE_ACCHEMY_RPC_BASE_URL

export const config = createConfig({
  chains: [PRIMARY_CHAIN, ENS_CHAIN],
  connectors: [
    injected({
      target: 'metaMask',
    }),
  ],
  transports: {
    [PRIMARY_CHAIN.id]: http(BASE_RPC_URL),
    [ENS_CHAIN.id]: http(), // Sepolia uses public RPC (only for ENS resolution)
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
