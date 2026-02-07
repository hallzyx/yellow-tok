# 📋 YellowTok — Product Definition Report (PDR)

> Product definition document for the **Hack the Money** hackathon.

---

## 📋 Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Project Objectives](#2-project-objectives)
3. [User Roles](#3-user-roles)
4. [MVP Features](#4-mvp-features)
5. [Technology Stack](#5-technology-stack)
6. [User Flows](#6-user-flows)
7. [Economic Model](#7-economic-model)
8. [Integrations](#8-integrations)
9. [Timeline](#9-timeline)

---

## 1. Executive Summary

**YellowTok** is a decentralized live streaming platform with instant tipping, inspired by TikTok Lives. It allows viewers to send micro-tips to streamers **without gas fees** and **without repetitive pop-ups**, using Yellow Network's off-chain transfers (ERC-7824).

### Value Proposition

| Platform | Creator Commission | Gas per Tip | Popups per Tip | Settlement |
|------------|--------------------:|:-----------:|:--------------:|:-----------:|
| TikTok | 50-70% | N/A | N/A | 2-4 weeks |
| Twitch | 50% | N/A | N/A | 15 days |
| **YellowTok** | **3-10%** | **$0** | **0** | **Instant** |

---

## 2. Project Objectives

### Main Objective

Demonstrate that Yellow Network enables a streaming tipping experience **comparable to Web2** (instant, frictionless) but with the advantages of Web3 (self-custody, transparency, low fees).

### Specific Objectives

| # | Objective | Success Metric |
|---|----------|-----------------|
| 1 | One-click authentication | ≤ 1 wallet popup per session |
| 2 | Instant gas-free tips | 0 on-chain transactions during tips |
| 3 | Efficient settlement | Exactly 1 on-chain tx when closing session |
| 4 | Decentralized identity | ENS name, avatar, and records resolved |
| 5 | Familiar UX | TikTok-style interface that doesn't intimidate new Web3 users |

---

## 3. User Roles

### 3.1 Viewer (Spectator)

| Aspect | Description |
|---------|-------------|
| **Who they are** | User who watches streams and sends tips |
| **Wallet** | MetaMask on Sepolia testnet |
| **Actions** | Connect wallet → Go Live → Select tips → End Stream |
| **Cost** | $0 gas per tip; only 1 tx when closing session (settlement) |
| **Budget** | Configurable via Spending Limit Modal |

### 3.2 Streamer (Creator)

| Aspect | Description |
|---------|-------------|
| **Who they are** | Content creator who receives tips |
| **Identity** | ENS name (avatar, bio, links) |
| **Income** | Receives USDC on-chain when viewer closes session |
| **Commission** | 90% standard / 97% partner |
| **Configuration** | Address in `.env` (`VITE_STREAMER_ADDRESS`) |

---

## 4. MVP Features

### 4.1 Core Features

| ID | Feature | Description | Priority | Status |
|----|---------|-------------|:---------:|:------:|
| F1 | Wallet Connection | MetaMask on Sepolia with wagmi | P0 | ✅ |
| F2 | Yellow Network Auth | EIP-712 challenge-response with ClearNode | P0 | ✅ |
| F3 | Session Keys | Ephemeral keys post-auth (no more popups) | P0 | ✅ |
| F4 | Off-chain Tips | `createTransferMessage` via session key | P0 | ✅ |
| F5 | On-chain Settlement | Transfer USDC to streamer when closing session | P0 | ✅ |
| F6 | USDC Balance | Real-time on-chain reading | P0 | ✅ |
| F7 | Spending Limit | Configurable budget per session | P1 | ✅ |

### 4.2 UX Features

| ID | Feature | Description | Priority | Status |
|----|---------|-------------|:---------:|:------:|
| U1 | TikTok-style Feed | Full-screen video card with overlay | P0 | ✅ |
| U2 | Tip Modal | 6 emoji levels (❤️🔥⭐💎🚀👑) | P0 | ✅ |
| U3 | Tip Animations | Floating emojis with framer-motion | P1 | ✅ |
| U4 | ENS Profiles | Avatar, name, bio, Twitter, URL, email | P1 | ✅ |
| U5 | 3D Landing Page | Hero with Three.js particle network | P2 | ✅ |
| U6 | Dark Theme | Yellow (#FACC15) + black (#0A0A0A) palette | P0 | ✅ |
| U7 | Spend Meter | Progress bar for spent vs. limit | P1 | ✅ |

### 4.3 Infrastructure

| ID | Feature | Description | Priority | Status |
|----|---------|-------------|:---------:|:------:|
| I1 | ClearNode WebSocket | Persistent connection + automatic reconnection | P0 | ✅ |
| I2 | Session Persistence | Session key in localStorage with fingerprint | P1 | ✅ |
| I3 | Error Handling | Timeouts, auth errors, insufficient balance | P0 | ✅ |
| I4 | Event System | Callbacks for reactive state | P0 | ✅ |

---

## 5. Technology Stack

| Layer | Technology | Justification |
|------|------------|---------------|
| **Frontend** | React 19 + Vite 6 | Hot reload, tree-shaking, native ES modules |
| **Language** | TypeScript 5 | Type safety for contracts and SDK |
| **Styling** | Tailwind CSS 4 | Utility-first, native dark mode |
| **Animations** | Framer Motion 12 | Fluid tip animations |
| **3D** | Three.js + @react-three/fiber | Landing page with node network effect |
| **Web3** | wagmi + viem | React hooks for wallet + contracts |
| **Icons** | Lucide React | Consistent SVG icons |
| **Routing** | React Router DOM 7 | SPA navigation with ENS params |
| **Payments** | @erc7824/nitrolite 0.5.3 | EIP-712 auth, session keys, off-chain transfers |
| **Network** | Sepolia Testnet | Testing without real funds |
| **Identity** | ENS (via wagmi) | Names, avatars, text records |

---

## 6. User Flows

### 6.1 Onboarding Flow

```
┌──────────────────────────────────────────────────────┐
│                    LANDING PAGE                       │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  🟡 YellowTok                                  │  │
│  │                                                │  │
│  │  ⚡ "Zero-gas tips for live streams"           │  │
│  │                                                │  │
│  │  [  Enter App  ] ← Link to /home               │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Features: Instant Tips / Zero Gas / ENS Identity    │
│  3D Background: Three.js particle network            │
│                                                      │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│                     HOME PAGE                         │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Header: [YellowTok] [Lives] [Explore]          │ │
│  │          [💲 25.00 USDC] [⚫ Go Live] [Connect] │ │
│  ├─────────────────────────────────────────────────┤ │
│  │                                                 │ │
│  │            ┌─────────────────┐                  │ │
│  │            │  LiveVideoCard  │                  │ │
│  │            │                 │                  │ │
│  │            │  🎤 vitalik.eth │                  │ │
│  │            │  🔴 LIVE        │                  │ │
│  │            │                 │                  │ │
│  │            │  [💰 Send Tip]  │                  │ │
│  │            └─────────────────┘                  │ │
│  │                                                 │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ① User connects MetaMask                            │
│  ② Click "Go Live" → EIP-712 popup (one time only)  │
│  ③ Active session → button changes to "End Stream"   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 6.2 Tipping Flow

```
┌──────────────────────────────────────────────────────┐
│                   ACTIVE SESSION                      │
│                                                      │
│  Header: [YellowTok] [💲 25.00] [🔴 End Stream]     │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  LiveVideoCard                                  │ │
│  │                                                 │ │
│  │  ┌──── SpendMeter ───────────────────────┐     │ │
│  │  │  ████████░░░░░░░░░░  $3/$10 (30%)     │     │ │
│  │  └───────────────────────────────────────┘     │ │
│  │                                                 │ │
│  │     🔥  ← TipAnimationLayer                    │ │
│  │         ⭐                                      │ │
│  │              💎                                  │ │
│  │                                                 │ │
│  │  [ 💰 Send Tip ] ← Click opens TipModal        │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ┌──── TipModal (overlay) ──────────────────────┐   │
│  │                                              │   │
│  │  ❤️ Heart    🔥 Fire     ⭐ Star             │   │
│  │  $1 USDC     $2 USDC     $5 USDC            │   │
│  │                                              │   │
│  │  💎 Diamond  🚀 Rocket   👑 Crown            │   │
│  │  $10 USDC    $20 USDC    $50 USDC           │   │
│  │                                              │   │
│  │        [ ✨ Send Tip ← $0 gas! ]             │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ④ User selects emoji + amount                       │
│  ⑤ Session key signs → ClearNode processes (off-chain)│
│  ⑥ Emoji animation + balance updated                 │
│  ⑦ Repeat unlimited (no popups or gas)               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 6.3 Settlement Flow

```
┌──────────────────────────────────────────────────────┐
│                   END STREAM                          │
│                                                      │
│  ⑧ User clicks "End Stream"                          │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │                                                │  │
│  │  📊 Session Summary:                           │  │
│  │                                                │  │
│  │  Budget:           $10.00 USDC                │  │
│  │  Total spent:      $8.00  USDC                │  │
│  │  Unused:           $2.00  USDC                │  │
│  │  Duration:         45 min                     │  │
│  │                                                │  │
│  │  ──────────────────────────────                │  │
│  │                                                │  │
│  │  🏛️ On-chain settlement:                       │  │
│  │  → USDC.transfer(streamer, $8.00)             │  │
│  │  → 1 transaction, ~0.0001 ETH gas             │  │
│  │                                                │  │
│  │  ✅ "Settlement complete!"                     │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ⑨ Only the spent amount is transferred on-chain     │
│  ⑩ Viewer retains unused balance                     │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 7. Economic Model

### 7.1 Commissions

| Tier | Rate | Streamer Receives | Platform |
|------|-----:|:---------------:|:----------:|
| Standard | 10% | 90% | 10% |
| Partner | 3% | 97% | 3% |

### 7.2 Session Example

```
Viewer deposits: $10 USDC (session budget)
Tips sent:
  - 3x ❤️ Heart ($1)  = $3
  - 2x 🔥 Fire ($2)   = $4
  - 1x ⭐ Star ($5)   = $5
  ─────────────────────
  Total tips:           $12 → exceeds budget
  Tip rejected:         ⭐ $5 (insufficient balance)
  Successful tips:      $7
  
Settlement:
  Streamer receives:    $6.30 (90% of $7)
  Platform:             $0.70 (10%)
  Viewer retains:       $3.00 (unspent)
  Total gas:            ~$0.001 (1 tx)
```

### 7.3 Comparison with Alternatives

| Metric | TikTok | Twitch | On-chain Donation | **YellowTok** |
|---------|--------|--------|-------------------|---------------|
| Gas per tip | N/A | N/A | ~$0.50-5.00 | **$0** |
| Tips per session | Unlimited | Unlimited | Limited by gas | **Unlimited** |
| On-chain tx/session | 0 | 0 | N tips = N tx | **1** |
| Wallet popups | 0 | 0 | N tips = N popups | **1** |
| Self-custody | ❌ | ❌ | ✅ | **✅** |
| Transparency | ❌ | ❌ | ✅ | **✅** |

---

## 8. Integrations

### 8.1 Yellow Network (Nitrolite SDK)

| Component | Function |
|------------|---------|
| `createAuthRequestMessage` | Initiate authentication flow |
| `createAuthVerifyMessage` | Complete auth with EIP-712 signature |
| `createEIP712AuthMessageSigner` | Signer for authentication |
| `createECDSAMessageSigner` | Signer for session key |
| `createTransferMessage` | Send off-chain tip |
| `createGetLedgerBalancesMessage` | Query balance in ClearNode |
| `parseAnyRPCResponse` | RPC message parser |

### 8.2 wagmi + viem

| Component | Function |
|------------|---------|
| `useAccount` | Wallet connection state |
| `useWalletClient` | Client for EIP-712 signing |
| `useEnsName/Address/Avatar/Text` | ENS identity resolution |
| `useReadContract` | Read USDC balance/allowance |
| `useWriteContract` | Approve/Transfer USDC |

### 8.3 ENS (Ethereum Name Service)

| Record | Use in YellowTok |
|--------|------------------|
| Name | Streamer name in feed |
| Avatar | Streamer profile picture |
| `description` | Biography on streamer page |
| `com.twitter` | Link to Twitter/X |
| `url` | Personal website |
| `email` | Streamer contact |

---

## 9. Timeline

### Hackathon Timeline

| Phase | Duration | Deliverables |
|------|----------|-------------|
| **Phase 1**: Core | Day 1-2 | Wallet connect, EIP-712 auth, session keys |
| **Phase 2**: Tipping | Day 2-3 | createTransferMessage, TipModal, animations |
| **Phase 3**: UX | Day 3-4 | ENS integration, 3D Landing, dark theme |
| **Phase 4**: Polish | Day 4-5 | Settlement, spending limits, error handling |
| **Phase 5**: Docs | Day 5 | README, ARCHITECTURE, PDR, demo |

### Post-Hackathon

| Phase | Deliverables |
|------|-------------|
| **v1.1** | Real WebRTC streaming, live chat |
| **v1.2** | Multi-streamer feed, leaderboard |
| **v2.0** | Mainnet deployment (Base), automatic settlement |

---

<div align="center">

📖 See also: [README.md](README.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [context.md](context.md)

**YellowTok** — Hack the Money 2025

</div>
