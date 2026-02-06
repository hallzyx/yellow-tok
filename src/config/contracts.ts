export const USDC_SEPOLIA_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const

/**
 * Custody contract where USDC is deposited to fund state channels.
 * In sandbox/hackathon mode we use the USDC contract itself as a
 * "self-custody" target — the approve step proves intent and the
 * ClearNode tracks the allowance as the session budget.
 *
 * In production, Yellow Network provides a dedicated Adjudicator
 * contract that holds the funds in escrow.
 */
export const YELLOW_CUSTODY_ADDRESS = '0xb3173d618e51277372B473e02E8ab05e97A3626c' as const

/** USDC decimals */
export const USDC_DECIMALS = 6 as const

export const ERC20_ABI = [
  // ── Read ─────────────────────────────────────────────
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: 'remaining', type: 'uint256' }],
    type: 'function',
  },
  // ── Write ────────────────────────────────────────────
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: 'success', type: 'bool' }],
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: 'success', type: 'bool' }],
    type: 'function',
  },
] as const
