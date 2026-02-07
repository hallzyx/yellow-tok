import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectButton } from './ConnectButton'
import { useYellow } from '../hooks/useYellow'
import { useState } from 'react'

// Streamer address from env (same as HomePage)
const STREAMER_ADDRESS =
  (import.meta.env.VITE_STREAMER_ADDRESS as `0x${string}`) ??
  '0xb3173d618e51277372B473e02E8ab05e97A3626c'

export function Header() {
  const { isConnected } = useAccount()
  const {
    isStreamActive,
    isConnectedToYellow,
    isInitializing,
    toggleStream,
    cleanupYellow,
    isCleaning,
    usdcBalance,
    isSettling,
    isWaitingForSettlement,
    error,
    depositStep,
  } = useYellow()
  const [isToggling, setIsToggling] = useState(false)

  const handleToggle = async () => {
    if (isToggling) return
    setIsToggling(true)
    try {
      const limit = parseFloat(localStorage.getItem('yellowtok_spend_limit') ?? '0.5')
      await toggleStream(STREAMER_ADDRESS, limit)
    } finally {
      setIsToggling(false)
    }
  }

  const isBusy = isToggling || isInitializing || isSettling || isWaitingForSettlement

  return (
    <header className="fixed top-0 left-0 right-0 z-50 header-blur border-b border-yt-border">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 group">
          <div className="w-10 h-10 rounded-xl bg-yt-primary flex items-center justify-center group-hover:glow-yellow-sm transition-all duration-300">
            <svg 
              viewBox="0 0 24 24" 
              fill="none" 
              className="w-6 h-6"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path 
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="text-xl font-bold">
            <span className="text-yt-text">Yellow</span>
            <span className="text-yt-primary">Tok</span>
          </span>
        </Link>

        {/* Center: Navigation + Stream Toggle */}
        <div className="flex items-center gap-6">
          <nav className="hidden md:flex items-center gap-8">
            <Link 
              to="/home" 
              className="text-yt-text-secondary hover:text-yt-text transition-colors duration-200 font-medium"
            >
              Lives
            </Link>
            <Link 
              to="/" 
              className="text-yt-text-secondary hover:text-yt-text transition-colors duration-200 font-medium"
            >
              Explore
            </Link>
          </nav>

          {/* Stream Switcher — only visible when wallet is connected */}
          {isConnected && (
            <div className="flex items-center gap-3">
              {/* USDC Balance Badge */}
              <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-yt-surface/80 border border-yt-border text-xs font-mono">
                <span className="text-blue-400">💲</span>
                <span className="text-yt-text">{usdcBalance.toFixed(2)}</span>
                <span className="text-yt-text-secondary">USDC</span>
              </div>

              {/* Go Live / End Stream — settlement (USDC transfer) happens on End Stream */}
              <button
              onClick={handleToggle}
              disabled={isBusy}
              className={`
                relative flex items-center gap-2 px-4 py-2 rounded-full 
                font-semibold text-sm transition-all duration-300
                disabled:opacity-60 disabled:cursor-not-allowed
                ${
                  isStreamActive
                    ? 'bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25'
                    : 'bg-yt-primary/15 text-yt-primary border border-yt-primary/30 hover:bg-yt-primary/25'
                }
              `}
            >
              {/* Status dot */}
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isStreamActive
                    ? 'bg-red-500 animate-pulse'
                    : isConnectedToYellow
                      ? 'bg-green-400'
                      : isSettling
                        ? 'bg-yellow-400 animate-pulse'
                        : 'bg-gray-500'
                }`}
              />

              {isBusy ? (
                <>
                  <svg
                    className="w-4 h-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  <span>{isSettling ? 'Settling tips…' : isWaitingForSettlement ? 'Confirming settlement…' : 'Connecting…'}</span>
                </>
              ) : isStreamActive ? (
                <>
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>End Stream</span>
                </>
              ) : (
                <>
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>Go Live</span>
                </>
              )}
            </button>

              {/* Cleanup button */}
              <button
                onClick={() => cleanupYellow()}
                disabled={isCleaning}
                title="Deep cleanup: close orphan channels, drain custody, reset state"
                className={`
                  flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold
                  transition-all duration-300
                  ${isCleaning
                    ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30 cursor-not-allowed'
                    : 'bg-yt-surface/80 text-yt-text-secondary border border-yt-border hover:border-orange-500/50 hover:text-orange-400'
                  }
                `}
              >
                {isCleaning ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>{depositStep || 'Cleaning...'}</span>
                  </>
                ) : (
                  <>
                    <span>🧹</span>
                    <span>Cleanup</span>
                  </>
                )}
              </button>

              {/* Error toast */}
              {error && (
                <span className="hidden lg:block text-xs text-red-400 max-w-[200px] truncate" title={error}>
                  ⚠ {error}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Connect Wallet */}
        <ConnectButton />
      </div>
    </header>
  )
}
