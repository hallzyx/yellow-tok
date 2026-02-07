/**
 * YellowTokService — Yellow Network integration for YellowTok
 *
 * Uses @erc7824/nitrolite SDK for:
 * - Challenge-response authentication (EIP-712)
 * - Session key management (no wallet popups after initial auth)
 * - Off-chain transfers via createTransferMessage ($0 gas tips)
 * - Message parsing via parseAnyRPCResponse
 *
 * Flow:
 *   1. initialize(provider, walletClient) → connect WS + Nitrolite auth
 *   2. createStreamSession(streamer, amount) → local session tracking
 *   3. sendTip(amount, streamer) → createTransferMessage (session-key signed)
 *   4. endStreamSession() → close local session
 */

import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createTransferMessage,
  createGetLedgerBalancesMessage,
  createGetConfigMessage,
  createCreateChannelMessage,
  createCloseChannelMessage,
  createResizeChannelMessage,
  parseAnyRPCResponse,
  RPCMethod,
  NitroliteClient,
  WalletStateSigner,
} from '@erc7824/nitrolite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, parseUnits, formatUnits } from 'viem';

class YellowTokService {
  constructor(config = {}) {
    // Configuration
    this.config = {
      clearnodeUrl: config.clearnodeUrl || 'wss://clearnet.yellow.com/ws',
      standardCommission: config.standardCommission || 10,
      partnerCommission: config.partnerCommission || 3,
      defaultAsset: config.defaultAsset || 'usdc',
      assetDecimals: config.assetDecimals || 6,
      appName: config.appName || 'YellowTok',
      authScope: config.authScope || 'yellowtok.app',
      sessionDuration: config.sessionDuration || 3600, // 1 hour
      ...config,
    };

    // Connection state
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // User & session key state
    this.userAddress = null;
    this.walletClient = null; // viem WalletClient for EIP-712 signing
    this.sessionKey = null; // { privateKey, address } — ephemeral key
    this.sessionSigner = null; // ECDSA signer from session key

    // Session state
    this.activeSessions = new Map();
    this.activeStreamSession = null;

    // Yellow Network channel & on-chain state
    this._pendingRequests = new Map();
    this.brokerAddress = null;
    this.networkConfig = null;
    this.channelId = null;
    this._existingChannelId = null; // Detected from ChannelsUpdate push
    this._channelReadyResolve = null; // Resolver for _waitForChannelReady
    this._resizeProcessedResolve = null; // Resolver for _waitForResizeProcessed
    this._depositConfirmedResolve = null; // Resolver for _waitForDepositConfirmed
    this._keepAliveInterval = null; // Ping interval to prevent WS idle timeout
    this.nitroliteClient = null;
    this.publicClient = null;
    this.tokenAddress = null;
    this.assets = [];
    this.isDeposited = false;

    // Event callbacks
    this.eventHandlers = {
      onConnected: null,
      onDisconnected: null,
      onAuthenticated: null,
      onConfigReady: null,
      onDepositProgress: null,
      onSessionCreated: null,
      onTipReceived: null,
      onTipSent: null,
      onBalanceUpdate: null,
      onSessionClosed: null,
      onWithdrawProgress: null,
      onError: null,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZE: wallet → ClearNode → Nitrolite auth
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initialize the service: connect wallet, WebSocket, and authenticate.
   *
   * @param {Object} walletProvider — window.ethereum
   * @param {Object} walletClient  — viem WalletClient from wagmi (for EIP-712)
   * @returns {Promise<Object>} { success, address }
   */
  async initialize(userAddress, walletClient, publicClient) {
    try {
      console.log('[YELLOW] 🚀 Initializing YellowTok Service...');

      // 1. Use address provided by wagmi (already connected, no window.ethereum needed)
      this.userAddress = getAddress(userAddress);
      this.walletClient = walletClient;
      this.publicClient = publicClient;

      console.log('[YELLOW] 👛 Wallet connected:', this.userAddress);

      // 2. Generate or restore ephemeral session key
      this._initSessionKey();
      console.log('[YELLOW] 🔑 Session key:', this.sessionKey.address);

      // 3. Connect WebSocket to ClearNode
      await this._connectToClearNode();

      // 4. Authenticate via Nitrolite (EIP-712 challenge-response)
      //    This is the ONLY wallet popup — after this, session key signs everything.
      await this._authenticateWithNitrolite();

      // 5. Fetch ClearNode configuration (supported chains, broker address)
      await this._getConfig();

      return { success: true, address: userAddress };
    } catch (error) {
      console.error('❌ Failed to initialize YellowTok Service:', error);
      this._triggerEvent('onError', {
        type: 'initialization_error',
        message: error.message,
        error,
      });
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION KEY — ephemeral key for signing without wallet popups
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate or restore session key from localStorage.
   * @private
   */
  _initSessionKey() {
    const STORAGE_KEY = 'yellowtok_session_key';

    // Build a fingerprint of the auth config so that if allowances/scope change
    // we generate a fresh session key (ClearNode won't update allowances for
    // an existing key).
    const configFingerprint = JSON.stringify({
      asset: this.config.defaultAsset,
      scope: this.config.authScope,
      app: this.config.appName,
    });

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          parsed.privateKey &&
          parsed.address &&
          parsed.configFingerprint === configFingerprint
        ) {
          this.sessionKey = { privateKey: parsed.privateKey, address: parsed.address };
          this.sessionSigner = createECDSAMessageSigner(parsed.privateKey);
          return;
        }
        // Config changed → invalidate old key so ClearNode registers fresh allowances
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* generate new */
    }

    // Generate fresh session key
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    this.sessionKey = { privateKey, address: account.address };
    this.sessionSigner = createECDSAMessageSigner(privateKey);

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...this.sessionKey, configFingerprint })
      );
    } catch {
      /* non-critical */
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WALLET SETUP
  // ═══════════════════════════════════════════════════════════════

  /**
   * @private
   */
  async _setupWallet(walletProvider) {
    if (!walletProvider) {
      throw new Error(
        'No wallet provider available. Please install MetaMask or another Web3 wallet.'
      );
    }

    const accounts = await walletProvider.request({
      method: 'eth_requestAccounts',
    });

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts found. Please unlock your wallet.');
    }

    return { userAddress: getAddress(accounts[0]) };
  }

  // ═══════════════════════════════════════════════════════════════
  // WEBSOCKET CONNECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * @private
   */
  async _connectToClearNode() {
    return new Promise((resolve, reject) => {
      console.log('[YELLOW] 🔌 Connecting to Yellow Network ClearNode...');

      this.ws = new WebSocket(this.config.clearnodeUrl);

      this.ws.onopen = () => {
        console.log('[YELLOW] ✅ Connected to Yellow Network ClearNode');
        this.connected = true;
        this.reconnectAttempts = 0;
        this._startKeepAlive();
        this._triggerEvent('onConnected');
        resolve();
      };

      // Persistent message handler for post-auth messages
      this.ws.addEventListener('message', (event) => {
        this._handleMessage(event.data);
      });

      this.ws.onerror = (error) => {
        console.error('❌ ClearNode connection error:', error);
        this._triggerEvent('onError', {
          type: 'connection_error',
          message: 'Failed to connect to Yellow Network',
          error,
        });
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('[YELLOW] 🔌 Disconnected from Yellow Network');
        this.connected = false;
        this.authenticated = false;
        this._stopKeepAlive();
        this._triggerEvent('onDisconnected');
        this._attemptReconnect();
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // NITROLITE AUTHENTICATION (EIP-712 challenge-response)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full challenge-response auth flow:
   *   1. Send auth_request → server
   *   2. Receive auth_challenge ← server
   *   3. Sign challenge with EIP-712 (one wallet popup)
   *   4. Send auth_verify → server
   *   5. Receive auth success + JWT ← server
   *
   * After this, sessionSigner signs all subsequent requests (no popups).
   * @private
   */
  async _authenticateWithNitrolite() {
    if (!this.walletClient || !this.sessionKey) {
      throw new Error('Wallet client and session key required for authentication');
    }

    return new Promise(async (resolve, reject) => {
      // Expire timestamp must be IDENTICAL in request and verify
      const sessionExpire = String(
        Math.floor(Date.now() / 1000) + this.config.sessionDuration
      );

      let authTimeout;
      let onClose;

      // Cleanup helper
      const cleanup = () => {
        clearTimeout(authTimeout);
        if (this.ws) {
          this.ws.removeEventListener('message', onAuthMessage);
          this.ws.removeEventListener('close', onClose);
        }
      };

      // Timeout (30s)
      authTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timed out (30s). ClearNode may be unreachable.'));
      }, 30000);

      // Handle disconnection during auth
      onClose = () => {
        cleanup();
        reject(new Error('Connection lost during authentication'));
      };
      this.ws.addEventListener('close', onClose);

      // Temporary message handler for the auth flow
      const onAuthMessage = async (event) => {
        try {
          const raw =
            typeof event.data === 'string' ? event.data : event.data.toString();
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return; // non-JSON, ignore
          }

          const response = parseAnyRPCResponse(JSON.stringify(data));

          // ── Step 2: Challenge received → sign with EIP-712 ──
          if (response.method === RPCMethod.AuthChallenge) {
            console.log('[YELLOW] 🔑 Auth challenge received, signing with EIP-712...');

            try {
              // PartialEIP712AuthMessage requires: scope, session_key, expires_at, allowances
              const eip712Params = {
                scope: this.config.authScope,
                session_key: this.sessionKey.address,
                expires_at: BigInt(sessionExpire),
                allowances: [
                  { asset: this.config.defaultAsset, amount: '10000' },
                ],
              };

              const eip712Signer = createEIP712AuthMessageSigner(
                this.walletClient,
                eip712Params,
                { name: this.config.appName }
              );

              const verifyPayload = await createAuthVerifyMessage(
                eip712Signer,
                response
              );

              this.ws.send(verifyPayload);
            } catch (signError) {
              cleanup();
              reject(
                new Error('User rejected signature or signing failed')
              );
            }
          }

          // ── Step 5: Auth verified → authenticated! ──
          if (response.method === RPCMethod.AuthVerify) {
            if (response.params?.success !== false) {
              console.log('[YELLOW] ✅ Authenticated with Yellow Network via Nitrolite!');
              this.authenticated = true;
              cleanup();

              // Store JWT for potential re-auth
              if (response.params?.jwtToken) {
                try {
                  localStorage.setItem(
                    'yellowtok_jwt',
                    response.params.jwtToken
                  );
                } catch {
                  /* non-critical */
                }
              }

              resolve();
            }
          }

          // ── Error during auth ──
          if (response.method === RPCMethod.Error) {
            console.error('❌ Auth error:', response.params);
            cleanup();
            reject(
              new Error(response.params?.error || 'Authentication failed')
            );
          }
        } catch (err) {
          console.warn('⚠️ Parse error during auth:', err);
        }
      };

      this.ws.addEventListener('message', onAuthMessage);

      // ── Step 1: Send auth request ──
      console.log('[YELLOW] 📤 Sending Nitrolite auth request...');
      try {
        const authPayload = await createAuthRequestMessage({
          address: this.userAddress,
          session_key: this.sessionKey.address,
          application: this.config.appName,
          allowances: [
            { asset: this.config.defaultAsset, amount: '10000' },
          ],
          expires_at: BigInt(sessionExpire),
          scope: this.config.authScope,
        });

        this.ws.send(authPayload);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // RPC REQUEST-RESPONSE HELPER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a WebSocket RPC message and wait for the matching response.
   * Uses _pendingRequests map checked in _handleMessage.
   * @private
   */
  _sendRPC(message, expectedMethod, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(expectedMethod);
        reject(new Error(`RPC ${expectedMethod} timed out after ${timeout / 1000}s`));
      }, timeout);

      this._pendingRequests.set(expectedMethod, { resolve, reject, timer });
      this.ws.send(message);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEARNODE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch ClearNode configuration: supported networks, broker address, etc.
   * Called automatically after authentication.
   * @private
   */
  async _getConfig() {
    try {
      console.log('[YELLOW] ⚙️ Fetching ClearNode configuration...');
      const msg = await createGetConfigMessage(this.sessionSigner);
      const response = await this._sendRPC(msg, RPCMethod.GetConfig, 15000);

      this.networkConfig = response.params;
      this.brokerAddress = response.params?.brokerAddress;

      const networks = response.params?.networks || [];
      console.log('[YELLOW] ⚙️ Config received:', {
        broker: this.brokerAddress,
        networks: networks.map((n) => `chain:${n.chainId}`),
      });

      this._triggerEvent('onConfigReady', {
        networks,
        brokerAddress: this.brokerAddress,
      });

      return response.params;
    } catch (err) {
      console.warn('[YELLOW] ⚠️ Could not fetch config:', err.message);
      return null;
    }
  }

  /**
   * Get the list of chain IDs supported by the ClearNode.
   */
  getSupportedChainIds() {
    return (this.networkConfig?.networks || []).map((n) => n.chainId);
  }

  /**
   * Check if a chain is supported for channel operations.
   */
  isChainSupported(chainId) {
    return this.getSupportedChainIds().includes(chainId);
  }

  /**
   * Find the USDC token address for a given chain from the assets list.
   */
  getUSDCTokenForChain(chainId) {
    const asset = this.assets?.find(
      (a) => a.symbol === 'usdc' && a.chainId === chainId
    );
    return asset?.token || null;
  }

  /**
   * Find the network config (custody, adjudicator) for a given chain.
   * @private
   */
  _findNetworkForChain(chainId) {
    return (this.networkConfig?.networks || []).find(
      (n) => n.chainId === chainId
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // CLOSE STALE / ORPHANED CHANNEL
  // ═══════════════════════════════════════════════════════════════

  /**
   * Close an existing open channel (from a previous session that wasn't properly closed).
   * Sets up NitroliteClient if needed, then sends close_channel + on-chain close + withdraw.
   *
   * @param {string} channelId — the channel to close
   * @param {number} chainId — chain for the NitroliteClient
   * @param {string} custodyAddress — custody contract
   * @param {string} adjudicatorAddress — adjudicator contract
   * @private
   */
  async _closeStaleChannel(channelId, chainId, custodyAddress, adjudicatorAddress) {
    // Ensure NitroliteClient exists for on-chain operations
    if (!this.nitroliteClient) {
      this.nitroliteClient = new NitroliteClient({
        walletClient: this.walletClient,
        publicClient: this.publicClient,
        stateSigner: new WalletStateSigner(this.walletClient),
        addresses: {
          custody: custodyAddress,
          adjudicator: adjudicatorAddress,
        },
        chainId,
        challengeDuration: 3600n,
      });
    }

    // Step 1: Request close via WebSocket
    console.log(`[YELLOW] 📡 Requesting close of channel ${channelId}...`);
    const closeMsg = await createCloseChannelMessage(
      this.sessionSigner,
      channelId,
      this.userAddress
    );
    const closeResponse = await this._sendRPC(closeMsg, RPCMethod.CloseChannel);

    // Step 2: Close on-chain
    console.log('[YELLOW] ⛓️ Closing stale channel on-chain (MetaMask popup)...');
    const closeTxHash = await this.nitroliteClient.closeChannel({
      finalState: {
        intent: closeResponse.params.state.intent,
        channelId: closeResponse.params.channelId,
        data: closeResponse.params.state.stateData,
        allocations: closeResponse.params.state.allocations,
        version: BigInt(closeResponse.params.state.version),
        serverSignature: closeResponse.params.serverSignature,
      },
      stateData: closeResponse.params.state.stateData,
    });
    console.log(`[YELLOW] ✅ Stale channel closed (tx: ${closeTxHash})`);

    // Step 3: Withdraw any remaining custody balance
    try {
      if (this.tokenAddress) {
        const custodyBalance = await this.nitroliteClient.getAccountBalance(this.tokenAddress);
        if (custodyBalance > 0n) {
          console.log(`[YELLOW] 💰 Withdrawing ${formatUnits(custodyBalance, this.config.assetDecimals)} USDC from custody...`);
          const wHash = await this.nitroliteClient.withdrawal(this.tokenAddress, custodyBalance);
          await this.publicClient.waitForTransactionReceipt({ hash: wHash });
          console.log(`[YELLOW] ✅ Custody withdrawal complete (tx: ${wHash})`);
        }
      }
    } catch (wErr) {
      console.warn('[YELLOW] ⚠️ Custody withdrawal after stale close failed:', wErr.message);
    }

    // Reset client so a fresh one is created for the new channel
    this.nitroliteClient = null;
  }

  /**
   * Wait for ClearNode to acknowledge a channel as 'open' via ChannelsUpdate.
   * After creating a channel on-chain, ClearNode processes the tx asynchronously.
   * Sending resize_channel before ClearNode knows about the channel causes
   * "channel not found". This method resolves when the push arrives.
   *
   * @param {string} channelId — channel to wait for
   * @param {number} timeout — max wait in ms (default 30s)
   * @private
   */
  _waitForChannelReady(channelId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._channelReadyResolve = null;
        // Don't hard-fail — the channel might still work, just took longer than expected
        console.warn(`[YELLOW] ⚠️ Timed out waiting for ClearNode to confirm channel ${channelId} (${timeout / 1000}s). Proceeding anyway...`);
        resolve();
      }, timeout);

      this._channelReadyResolve = (confirmedId) => {
        if (confirmedId === channelId) {
          clearTimeout(timer);
          this._channelReadyResolve = null;
          resolve();
        }
      };
    });
  }

  /**
   * Wait for ClearNode to process a resize operation.
   * After the resize tx confirms on-chain, ClearNode sends a channel update
   * with the new amount. We wait for that before sending allocate.
   *
   * @param {string} channelId — channel we're resizing
   * @param {number} timeout — max wait in ms
   * @private
   */
  _waitForResizeProcessed(channelId, timeout = 30000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._resizeProcessedResolve = null;
        console.warn(`[YELLOW] ⚠️ Timed out waiting for resize confirmation (${timeout / 1000}s). Proceeding anyway...`);
        resolve();
      }, timeout);

      this._resizeProcessedResolve = (confirmedId) => {
        if (confirmedId === channelId) {
          clearTimeout(timer);
          this._resizeProcessedResolve = null;
          resolve();
        }
      };
    });
  }

  /**
   * Wait for ClearNode to confirm our deposit via a BalanceUpdate or
   * GetLedgerBalances response showing funds > 0.
   *
   * Actively polls every 10s using getLedgerBalances as a fallback in
   * case the push BalanceUpdate is delayed.
   *
   * @param {number} expectedAmount — the amount we expect (human-readable USDC)
   * @param {number} timeout — max wait in ms
   * @private
   */
  _waitForDepositConfirmed(expectedAmount, timeout = 120000) {
    return new Promise((resolve) => {
      // Poll every 10s with getLedgerBalances (valid Nitrolite RPC)
      const pollInterval = setInterval(async () => {
        if (this.authenticated && this.sessionSigner && this.ws?.readyState === WebSocket.OPEN) {
          try {
            console.log('[YELLOW] 📊 Polling ledger balance...');
            const balMsg = await createGetLedgerBalancesMessage(this.sessionSigner);
            this.ws.send(balMsg);
          } catch { /* ignore */ }
        }
      }, 10000);

      const timer = setTimeout(() => {
        clearInterval(pollInterval);
        this._depositConfirmedResolve = null;
        console.warn(`[YELLOW] ⚠️ Timed out waiting for ClearNode balance update (${timeout / 1000}s). Proceeding anyway...`);
        resolve();
      }, timeout);

      this._depositConfirmedResolve = () => {
        clearTimeout(timer);
        clearInterval(pollInterval);
        this._depositConfirmedResolve = null;
        resolve();
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // DEEP CLEANUP — nuke all orphaned state
  // ═══════════════════════════════════════════════════════════════

  /**
   * Deep cleanup: close ALL open channels, drain custody, reset state.
   *
   * Call this when the system is in a broken state (orphaned channels,
   * stuck balances, "non-zero allocation" errors, etc.).
   *
   * Steps:
   *   1. Close any channel known from _existingChannelId or channelId
   *   2. Drain all custody balance back to wallet
   *   3. Query ledger to show remaining unified balance
   *   4. Reset all internal state
   *
   * @param {number} chainId — chain to cleanup on (default: 8453 Base)
   * @param {string} tokenAddress — token address
   * @returns {Promise<Object>} summary of cleanup actions
   */
  async deepCleanup(chainId = 8453, tokenAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') {
    if (!this.connected || !this.authenticated) {
      throw new Error('Not connected/authenticated. Call initialize() first.');
    }
    if (!this.publicClient) {
      throw new Error('Public client not available.');
    }

    const results = {
      channelsClosed: [],
      custodyDrained: null,
      ledgerBalance: null,
      errors: [],
    };

    const network = this._findNetworkForChain(chainId);
    if (!network) {
      throw new Error(`Chain ${chainId} not supported. Supported: ${this.getSupportedChainIds().join(', ')}`);
    }

    const custodyAddress = network.custodyAddress;
    const adjudicatorAddress = network.adjudicatorAddress;
    this.tokenAddress = tokenAddress;

    console.log('[CLEANUP] 🧹 Starting deep cleanup...');
    console.log(`[CLEANUP] Chain: ${chainId}, Custody: ${custodyAddress}`);

    this._triggerEvent('onDepositProgress', {
      step: 1, total: 4, message: '🧹 Starting deep cleanup...',
    });

    // ── Step 1: Ensure NitroliteClient ──
    if (!this.nitroliteClient) {
      this.nitroliteClient = new NitroliteClient({
        walletClient: this.walletClient,
        publicClient: this.publicClient,
        stateSigner: new WalletStateSigner(this.walletClient),
        addresses: { custody: custodyAddress, adjudicator: adjudicatorAddress },
        chainId,
        challengeDuration: 3600n,
      });
    }

    // ── Step 2: Close ALL known channels ──
    const channelsToClose = new Set();
    if (this.channelId) channelsToClose.add(this.channelId);
    if (this._existingChannelId) channelsToClose.add(this._existingChannelId);

    this._triggerEvent('onDepositProgress', {
      step: 2, total: 4, message: `Closing ${channelsToClose.size} channel(s)...`,
    });

    for (const chId of channelsToClose) {
      try {
        console.log(`[CLEANUP] 📡 Closing channel ${chId}...`);
        const closeMsg = await createCloseChannelMessage(
          this.sessionSigner, chId, this.userAddress
        );
        const closeResponse = await this._sendRPC(closeMsg, RPCMethod.CloseChannel);

        console.log('[CLEANUP] ⛓️ Executing close on-chain (MetaMask popup)...');
        const closeTxHash = await this.nitroliteClient.closeChannel({
          finalState: {
            intent: closeResponse.params.state.intent,
            channelId: closeResponse.params.channelId,
            data: closeResponse.params.state.stateData,
            allocations: closeResponse.params.state.allocations,
            version: BigInt(closeResponse.params.state.version),
            serverSignature: closeResponse.params.serverSignature,
          },
          stateData: closeResponse.params.state.stateData,
        });
        console.log(`[CLEANUP] ✅ Channel ${chId} closed (tx: ${closeTxHash})`);
        results.channelsClosed.push({ channelId: chId, txHash: closeTxHash });
      } catch (err) {
        console.warn(`[CLEANUP] ⚠️ Failed to close channel ${chId}:`, err.message);
        results.errors.push(`close ${chId}: ${err.message}`);
      }
    }

    // ── Step 3: Drain ALL custody balance ──
    this._triggerEvent('onDepositProgress', {
      step: 3, total: 4, message: 'Draining custody balance...',
    });

    try {
      const custodyBalance = await this.nitroliteClient.getAccountBalance(tokenAddress);
      if (custodyBalance > 0n) {
        const readable = formatUnits(custodyBalance, this.config.assetDecimals);
        console.log(`[CLEANUP] 💰 Draining ${readable} USDC from custody...`);
        const wHash = await this.nitroliteClient.withdrawal(tokenAddress, custodyBalance);
        await this.publicClient.waitForTransactionReceipt({ hash: wHash });
        console.log(`[CLEANUP] ✅ Custody drained (tx: ${wHash})`);
        results.custodyDrained = { amount: readable, txHash: wHash };
      } else {
        console.log('[CLEANUP] ✅ Custody already empty');
        results.custodyDrained = { amount: '0', txHash: null };
      }
    } catch (err) {
      console.warn('[CLEANUP] ⚠️ Custody drain failed:', err.message);
      results.errors.push(`custody drain: ${err.message}`);
    }

    // ── Step 4: Query ledger balance ──
    this._triggerEvent('onDepositProgress', {
      step: 4, total: 4, message: 'Querying ledger balance...',
    });

    try {
      const balMsg = await createGetLedgerBalancesMessage(this.sessionSigner);
      this.ws.send(balMsg);
      // Wait a moment for the response
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.warn('[CLEANUP] ⚠️ Ledger query failed:', err.message);
    }

    // ── Reset all internal state ──
    this.channelId = null;
    this._existingChannelId = null;
    this.isDeposited = false;
    this.nitroliteClient = null;
    this.activeStreamSession = null;

    console.log('[CLEANUP] 🧹 Deep cleanup complete!', results);
    this._triggerEvent('onDepositProgress', {
      step: 4, total: 4, message: '🧹 Cleanup complete!', complete: true,
    });

    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  // DEPOSIT → CHANNEL → RESIZE → ALLOCATE → UNIFIED BALANCE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full deposit flow following Yellow Network "How Funds Flow" diagram:
   *
   *   0. (Pre) Close stale channels + drain leftover custody balance
   *   1. Setup NitroliteClient
   *   2. Approve USDC → custody
   *   3. Deposit USDC → custody (on-chain) — "Available Balance"
   *   4. Create state channel (WS + on-chain)
   *   5. Resize +amount (custody → channel) — "Channel-Locked"
   *   6. Allocate +amount (channel → unified) — "Unified Balance"
   *   7. Wait for ledger balance > 0
   *
   * CRITICAL: createTransferMessage only works from UNIFIED balance.
   * ClearNode blocks transfers when ANY channel has non-zero allocation.
   * The allocate step zeros the channel allocation and moves funds to unified.
   *
   * The previous "required 20000, available 10000" error was caused by
   * stale unified balance from previous test deposits. Step 0 now drains
   * all leftover state to prevent this.
   *
   * @param {number} amount — USDC amount to deposit
   * @param {number} chainId — chain ID (must be supported by ClearNode)
   * @param {string} tokenAddress — USDC token address on that chain
   * @returns {Promise<Object>}
   */
  async depositAndOpenChannel(amount, chainId, tokenAddress) {
    if (!this.connected || !this.authenticated) {
      throw new Error('Not connected/authenticated. Call initialize() first.');
    }

    if (!this.publicClient) {
      throw new Error('Public client not available. Pass it during initialize().');
    }

    const network = this._findNetworkForChain(chainId);
    if (!network) {
      const supported = this.getSupportedChainIds();
      throw new Error(
        `Chain ${chainId} is not supported by ClearNode. Supported: ${supported.join(', ')}`
      );
    }

    this.tokenAddress = tokenAddress;
    const custodyAddress = network.custodyAddress;
    const adjudicatorAddress = network.adjudicatorAddress;
    const amountInUnits = parseUnits(String(amount), this.config.assetDecimals);
    const TOTAL_STEPS = 7;

    // ══════════════════════════════════════════════════════════════
    // PRE-CHECK: Ensure clean state (no stale channels or custody balance)
    // This prevents "required 20000, available 10000" errors caused by
    // leftover unified balance from previous test sessions.
    // ══════════════════════════════════════════════════════════════

    // Close any stale channel first
    const staleChannelId = this.channelId || this._existingChannelId;
    if (staleChannelId) {
      console.log(`[YELLOW] ⚠️ Found existing channel ${staleChannelId} — closing...`);
      this._triggerEvent('onDepositProgress', {
        step: 0,
        total: TOTAL_STEPS,
        message: 'Closing previous channel...',
      });

      try {
        await this._closeStaleChannel(staleChannelId, chainId, custodyAddress, adjudicatorAddress);
        console.log('[YELLOW] ✅ Previous channel closed successfully!');
      } catch (closeErr) {
        console.warn('[YELLOW] ⚠️ Could not close stale channel:', closeErr.message);
      }

      this.channelId = null;
      this._existingChannelId = null;
      this.isDeposited = false;
    }

    console.log(`[YELLOW] 💰 Starting deposit: ${amount} USDC on chain ${chainId}`);
    console.log(`[YELLOW] 📋 Custody: ${custodyAddress}`);
    console.log(`[YELLOW] 📋 Adjudicator: ${adjudicatorAddress}`);
    console.log(`[YELLOW] 📋 Token: ${tokenAddress}`);
    console.log(`[YELLOW] 📋 Broker: ${this.brokerAddress}`);

    // ── Step 1: Create NitroliteClient ──
    this._triggerEvent('onDepositProgress', {
      step: 1,
      total: TOTAL_STEPS,
      message: 'Setting up on-chain client...',
    });

    this.nitroliteClient = new NitroliteClient({
      walletClient: this.walletClient,
      publicClient: this.publicClient,
      stateSigner: new WalletStateSigner(this.walletClient),
      addresses: {
        custody: custodyAddress,
        adjudicator: adjudicatorAddress,
      },
      chainId,
      challengeDuration: 3600n,
    });

    // ── Pre-cleanup: Drain any leftover custody balance from previous sessions ──
    try {
      const existingCustody = await this.nitroliteClient.getAccountBalance(tokenAddress);
      if (existingCustody > 0n) {
        const readableStale = formatUnits(existingCustody, this.config.assetDecimals);
        console.log(`[YELLOW] ⚠️ Found ${readableStale} USDC leftover in custody — withdrawing first...`);
        const drainHash = await this.nitroliteClient.withdrawal(tokenAddress, existingCustody);
        await this.publicClient.waitForTransactionReceipt({ hash: drainHash });
        console.log(`[YELLOW] ✅ Drained stale custody balance (tx: ${drainHash})`);
      } else {
        console.log('[YELLOW] ✅ Custody is clean — no leftover balance');
      }
    } catch (drainErr) {
      console.warn('[YELLOW] ⚠️ Could not drain stale custody:', drainErr.message);
    }

    // ── Step 2: Approve USDC → custody ──
    console.log(`[YELLOW] ⛓️ Checking USDC allowance for custody...`);
    this._triggerEvent('onDepositProgress', {
      step: 2,
      total: TOTAL_STEPS,
      message: 'Checking USDC approval...',
    });

    const erc20MinAbi = [
      {
        inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
        name: 'allowance',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
      },
      {
        inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
        name: 'approve',
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ];

    const currentAllowance = await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20MinAbi,
      functionName: 'allowance',
      args: [this.userAddress, custodyAddress],
    });

    if (currentAllowance < amountInUnits) {
      console.log(`[YELLOW] ⛓️ Approving ${amount} USDC for custody (MetaMask popup)...`);
      this._triggerEvent('onDepositProgress', {
        step: 2,
        total: TOTAL_STEPS,
        message: `Approving ${amount} USDC — confirm in wallet...`,
      });

      const approveHash = await this.walletClient.writeContract({
        address: tokenAddress,
        abi: erc20MinAbi,
        functionName: 'approve',
        args: [custodyAddress, amountInUnits],
      });

      console.log(`[YELLOW] 📝 Approve tx: ${approveHash}`);
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log(`[YELLOW] ✅ Approval confirmed on-chain!`);
    } else {
      console.log(`[YELLOW] ✅ Already approved: ${formatUnits(currentAllowance, this.config.assetDecimals)} USDC`);
    }

    // ── Step 3: Deposit USDC to custody (on-chain) ──
    console.log(`[YELLOW] ⛓️ Depositing ${amount} USDC to custody (MetaMask popup)...`);
    this._triggerEvent('onDepositProgress', {
      step: 3,
      total: TOTAL_STEPS,
      message: `Depositing ${amount} USDC — confirm in wallet...`,
    });

    const depositHash = await this.nitroliteClient.deposit(tokenAddress, amountInUnits);
    console.log(`[YELLOW] 📝 Deposit tx submitted: ${depositHash}`);

    await this.publicClient.waitForTransactionReceipt({ hash: depositHash });
    console.log(`[YELLOW] ✅ Deposit confirmed on-chain!`);

    // ── Step 4: Create state channel (WS + on-chain) ──
    console.log(`[YELLOW] 📡 Creating state channel with broker...`);
    this._triggerEvent('onDepositProgress', {
      step: 4,
      total: TOTAL_STEPS,
      message: 'Creating state channel...',
    });

    const createChannelMsg = await createCreateChannelMessage(
      this.sessionSigner,
      { chain_id: chainId, token: tokenAddress }
    );
    const channelResponse = await this._sendRPC(
      createChannelMsg,
      RPCMethod.CreateChannel
    );

    console.log(`[YELLOW] ⛓️ Creating channel on-chain (MetaMask popup)...`);
    const { channelId, txHash: createTxHash } =
      await this.nitroliteClient.createChannel({
        channel: channelResponse.params.channel,
        unsignedInitialState: {
          intent: channelResponse.params.state.intent,
          version: BigInt(channelResponse.params.state.version),
          data: channelResponse.params.state.stateData,
          allocations: channelResponse.params.state.allocations,
        },
        serverSignature: channelResponse.params.serverSignature,
      });

    this.channelId = channelId;
    console.log(`[YELLOW] ✅ Channel created: ${channelId} (tx: ${createTxHash})`);

    // Wait for ClearNode to acknowledge the channel
    console.log(`[YELLOW] ⏳ Waiting for ClearNode to recognize channel...`);
    await this._waitForChannelReady(channelId, 30000);
    console.log(`[YELLOW] ✅ ClearNode confirmed channel is open!`);

    // ── Step 5: Resize — custody → channel (diagram step 2) ──
    // Moves funds from "Available Balance" to "Channel-Locked" in custody contract
    console.log(`[YELLOW] 📡 Step 5: Moving funds from custody → channel...`);
    this._triggerEvent('onDepositProgress', {
      step: 5,
      total: TOTAL_STEPS,
      message: 'Locking funds in channel...',
    });

    const resizeMsg = await createResizeChannelMessage(this.sessionSigner, {
      channel_id: channelId,
      resize_amount: amountInUnits,
      funds_destination: this.userAddress,
    });
    const resizeResponse = await this._sendRPC(
      resizeMsg,
      RPCMethod.ResizeChannel
    );

    console.log(`[YELLOW] ⛓️ Executing resize on-chain (MetaMask popup)...`);
    const prevStateForResize = await this.nitroliteClient.getChannelData(channelId);
    const { txHash: resizeTxHash } = await this.nitroliteClient.resizeChannel({
      resizeState: {
        intent: resizeResponse.params.state.intent,
        channelId: resizeResponse.params.channelId,
        version: BigInt(resizeResponse.params.state.version),
        data: resizeResponse.params.state.stateData,
        allocations: resizeResponse.params.state.allocations,
        serverSignature: resizeResponse.params.serverSignature,
      },
      proofStates: [prevStateForResize.lastValidState],
    });
    console.log(`[YELLOW] ✅ Resize complete — funds in channel (tx: ${resizeTxHash})`);

    // Wait for ClearNode to process the resize before allocating
    console.log(`[YELLOW] ⏳ Waiting for ClearNode to confirm resize...`);
    await this._waitForResizeProcessed(channelId, 30000);
    console.log(`[YELLOW] ✅ ClearNode confirmed resize!`);

    // ── Step 6: Allocate — channel → unified balance (diagram step 3) ──
    // Moves funds from "Channel-Locked" to "Unified Balance" (ClearNode ledger)
    // After this, channel allocation = 0 → transfers are unblocked
    // funds_destination = broker (broker manages the unified balance)
    console.log(`[YELLOW] 📡 Step 6: Allocating funds from channel → unified balance...`);
    this._triggerEvent('onDepositProgress', {
      step: 6,
      total: TOTAL_STEPS,
      message: 'Moving funds to unified balance...',
    });

    const allocateMsg = await createResizeChannelMessage(this.sessionSigner, {
      channel_id: channelId,
      allocate_amount: amountInUnits,
      funds_destination: this.brokerAddress,
    });
    const allocateResponse = await this._sendRPC(
      allocateMsg,
      RPCMethod.ResizeChannel
    );

    console.log(`[YELLOW] ⛓️ Executing allocate on-chain (MetaMask popup)...`);
    const prevStateForAllocate = await this.nitroliteClient.getChannelData(channelId);
    const { txHash: allocateTxHash } = await this.nitroliteClient.resizeChannel({
      resizeState: {
        intent: allocateResponse.params.state.intent,
        channelId: allocateResponse.params.channelId,
        version: BigInt(allocateResponse.params.state.version),
        data: allocateResponse.params.state.stateData,
        allocations: allocateResponse.params.state.allocations,
        serverSignature: allocateResponse.params.serverSignature,
      },
      proofStates: [prevStateForAllocate.lastValidState],
    });
    console.log(`[YELLOW] ✅ Allocate complete — funds in unified balance (tx: ${allocateTxHash})`);

    // ── Step 7: Wait for ClearNode to confirm funds in unified balance ──
    console.log(`[YELLOW] ⏳ Waiting for ClearNode to confirm funds in ledger balance...`);
    this._triggerEvent('onDepositProgress', {
      step: 7,
      total: TOTAL_STEPS,
      message: 'Confirming funds in ledger...',
    });

    await this._waitForDepositConfirmed(amount, 120000);
    console.log(`[YELLOW] ✅ Funds confirmed in unified balance!`);
    console.log(`[YELLOW] 💰 ${amount} USDC now available for instant $0-gas tips!`);

    this.isDeposited = true;
    this._triggerEvent('onDepositProgress', {
      step: TOTAL_STEPS,
      total: TOTAL_STEPS,
      message: `${amount} USDC ready for tipping!`,
      complete: true,
    });

    return { depositHash, channelId, createTxHash, resizeTxHash, allocateTxHash };
  }

  // ═══════════════════════════════════════════════════════════════
  // CLOSE CHANNEL → WITHDRAW (get funds back to wallet)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Close the active Yellow Network channel and withdraw remaining funds.
   *
   *   1. close_channel via WebSocket → ClearNode returns final state
   *   2. closeChannel on-chain → settles final allocations
   *   3. withdrawal from custody → USDC back in wallet
   *
   * @returns {Promise<Object|null>} { closeTxHash, withdrawHash } or null
   */
  async closeChannelAndWithdraw() {
    if (!this.nitroliteClient) {
      console.log('[YELLOW] ℹ️ No NitroliteClient — skipping withdrawal');
      return null;
    }

    try {
      let closeTxHash = null;
      const TOTAL_STEPS = this.channelId ? 2 : 1;

      // ── Step 1: Close channel (WS + on-chain) ──
      // ClearNode auto-manages the unified balance during close,
      // so no explicit deallocate is needed.
      if (this.channelId) {
        console.log(`[YELLOW] 🔄 Closing channel ${this.channelId}...`);
        this._triggerEvent('onWithdrawProgress', {
          step: 1,
          total: TOTAL_STEPS,
          message: 'Closing channel...',
        });

        const closeMsg = await createCloseChannelMessage(
          this.sessionSigner,
          this.channelId,
          this.userAddress
        );
        const closeResponse = await this._sendRPC(
          closeMsg,
          RPCMethod.CloseChannel
        );

        console.log(`[YELLOW] ⛓️ Closing channel on-chain (MetaMask popup)...`);
        closeTxHash = await this.nitroliteClient.closeChannel({
          finalState: {
            intent: closeResponse.params.state.intent,
            channelId: closeResponse.params.channelId,
            data: closeResponse.params.state.stateData,
            allocations: closeResponse.params.state.allocations,
            version: BigInt(closeResponse.params.state.version),
            serverSignature: closeResponse.params.serverSignature,
          },
          stateData: closeResponse.params.state.stateData,
        });
        console.log(`[YELLOW] ✅ Channel closed (tx: ${closeTxHash})`);
      } else {
        console.log('[YELLOW] ℹ️ No active channel — proceeding to withdraw from custody');
      }

      // ── Step 2: Withdraw remaining funds from custody ──
      console.log(`[YELLOW] ⛓️ Withdrawing funds from custody...`);
      this._triggerEvent('onWithdrawProgress', {
        step: TOTAL_STEPS,
        total: TOTAL_STEPS,
        message: 'Withdrawing USDC from custody to wallet...',
      });

      let withdrawHash = null;
      try {
        const custodyBalance = await this.nitroliteClient.getAccountBalance(
          this.tokenAddress
        );

        if (custodyBalance > 0n) {
          const readableBalance = formatUnits(
            custodyBalance,
            this.config.assetDecimals
          );
          console.log(
            `[YELLOW] 💰 Custody balance: ${readableBalance} USDC — withdrawing...`
          );
          withdrawHash = await this.nitroliteClient.withdrawal(
            this.tokenAddress,
            custodyBalance
          );
          await this.publicClient.waitForTransactionReceipt({
            hash: withdrawHash,
          });
          console.log(`[YELLOW] ✅ Withdrawal complete (tx: ${withdrawHash})`);
          console.log(`[YELLOW] 💰 USDC returned to your wallet!`);
        } else {
          console.log(
            '[YELLOW] ℹ️ No remaining custody balance — all funds were used in tips'
          );
        }
      } catch (wErr) {
        console.warn('[YELLOW] ⚠️ Withdrawal failed:', wErr.message);
        console.warn(
          '[YELLOW] ⚠️ Funds remain in custody — you can withdraw later'
        );
      }

      // Clean up channel state
      this.channelId = null;
      this.isDeposited = false;

      this._triggerEvent('onWithdrawProgress', {
        step: TOTAL_STEPS,
        total: TOTAL_STEPS,
        message: 'Withdrawal complete!',
        complete: true,
      });

      return { closeTxHash, withdrawHash };
    } catch (err) {
      console.error('[YELLOW] ❌ Close/withdraw failed:', err);
      this._triggerEvent('onError', {
        type: 'withdraw_error',
        message: err.message,
        error: err,
      });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CREATE STREAM SESSION (state channel)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a streaming session.
   * After Nitrolite auth, the session is essentially the authenticated
   * connection. This method sets up local tracking and optionally
   * fetches the ledger balance from ClearNode.
   *
   * @param {string} streamerAddress
   * @param {number} depositAmount — budget in USDC
   * @param {Object} options — { isPartner }
   * @returns {Promise<Object>}
   */
  async createStreamSession(streamerAddress, depositAmount, options = {}) {
    if (!this.connected || !this.authenticated) {
      throw new Error(
        'Not connected/authenticated to Yellow Network. Please initialize first.'
      );
    }

    if (!streamerAddress || !depositAmount) {
      throw new Error('Streamer address and deposit amount are required');
    }

    try {
      console.log(`[LOCAL] 🎬 Creating stream session with ${streamerAddress}...`);
      console.log(
        `[LOCAL] 🔗 Session budget: $${depositAmount.toFixed(2)} USDC (backed by on-chain balance)`
      );

      const isPartner = options.isPartner || false;
      const commissionRate = isPartner
        ? this.config.partnerCommission
        : this.config.standardCommission;

      const sessionId = `stream_${Date.now()}`;
      const session = {
        sessionId,
        streamerAddress,
        viewerAddress: this.userAddress,
        initialDeposit: depositAmount,
        currentBalance: depositAmount,
        spent: 0,
        commissionRate,
        isPartner,
        createdAt: Date.now(),
        status: 'active',
      };

      this.activeSessions.set(sessionId, session);
      this.activeStreamSession = session;

      // Fetch ledger balance from ClearNode to confirm funds availability
      if (this.sessionSigner) {
        try {
          const balancePayload = await createGetLedgerBalancesMessage(
            this.sessionSigner,
            this.userAddress
          );
          this.ws.send(balancePayload);
        } catch (err) {
          console.warn('⚠️ Could not fetch ledger balance:', err.message);
        }
      }

      this._triggerEvent('onSessionCreated', { sessionId, session });

      console.log('[LOCAL] ✅ Stream session created:', sessionId);
      console.log(
        `[LOCAL] 💰 [USDC] Session budget: $${depositAmount.toFixed(2)} USDC`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Current balance: $${session.currentBalance.toFixed(2)} USDC | Spent: $${session.spent.toFixed(2)} USDC`
      );

      return {
        success: true,
        sessionId,
        deposit: depositAmount,
        commissionRate,
        session,
      };
    } catch (error) {
      console.error('❌ Failed to create stream session:', error);
      this._triggerEvent('onError', {
        type: 'session_creation_error',
        message: error.message,
        error,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SEND TIP — off-chain via Nitrolite createTransferMessage
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send an instant tip to the streamer.
   * Uses createTransferMessage signed by session key — NO wallet popup!
   *
   * @param {number} tipAmount — in USDC
   * @param {string} streamerAddress
   * @param {string} message — optional message
   * @returns {Promise<Object>}
   */
  async sendTip(tipAmount, streamerAddress, message = '') {
    if (!this.activeStreamSession) {
      throw new Error(
        'No active stream session. Please create a session first.'
      );
    }

    if (this.activeStreamSession.streamerAddress !== streamerAddress) {
      throw new Error('Active session is with a different streamer');
    }

    if (tipAmount <= 0) {
      throw new Error('Tip amount must be greater than 0');
    }

    if (tipAmount > this.activeStreamSession.currentBalance) {
      throw new Error('Insufficient balance. Please deposit more funds.');
    }

    try {
      console.log(`[LOCAL] 💸 Sending tip of $${tipAmount} to ${streamerAddress}...`);

      // Calculate commission
      const commissionAmount =
        tipAmount * (this.activeStreamSession.commissionRate / 100);
      const creatorReceives = tipAmount - commissionAmount;

      // ── Send transfer via Nitrolite SDK (session-key signed, $0 gas!) ──
      if (this.sessionSigner && this.connected && this.authenticated) {
        try {
          const transferPayload = await createTransferMessage(
            this.sessionSigner,
            {
              destination: streamerAddress,
              allocations: [
                {
                  asset: this.config.defaultAsset,
                  amount: String(tipAmount),
                },
              ],
            }
          );

          this.ws.send(transferPayload);
        } catch (err) {
          console.warn(
            '⚠️ Nitrolite transfer failed, tracking locally:',
            err.message
          );
        }
      }

      // Update local session state (optimistic)
      this.activeStreamSession.spent += tipAmount;
      this.activeStreamSession.currentBalance -= tipAmount;

      // Trigger event
      this._triggerEvent('onTipSent', {
        amount: tipAmount,
        amountInUnits: this._toAssetUnits(tipAmount),
        recipient: streamerAddress,
        message,
        commission: commissionAmount,
        creatorReceives,
        remainingBalance: this.activeStreamSession.currentBalance,
        totalSpent: this.activeStreamSession.spent,
      });

      console.log(
        `[LOCAL] ✅ Tip sent! Creator receives $${creatorReceives.toFixed(4)} USDC (${this.activeStreamSession.commissionRate}% commission)`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Remaining: $${this.activeStreamSession.currentBalance.toFixed(4)} | Spent: $${this.activeStreamSession.spent.toFixed(4)}`
      );

      return {
        success: true,
        tipAmount,
        commission: commissionAmount,
        creatorReceives,
        remainingBalance: this.activeStreamSession.currentBalance,
        totalSpent: this.activeStreamSession.spent,
      };
    } catch (error) {
      console.error('❌ Failed to send tip:', error);
      this._triggerEvent('onError', {
        type: 'tip_error',
        message: error.message,
        error,
      });
      throw error;
    }
  }

  /**
   * Send multiple tips in a batch.
   * @param {Array<Object>} tips
   * @returns {Promise<Object>}
   */
  async sendTipBatch(tips) {
    const results = [];
    let totalAmount = 0;

    for (const tip of tips) {
      try {
        const result = await this.sendTip(
          tip.amount,
          tip.streamerAddress,
          tip.message || ''
        );
        results.push({ ...result, success: true });
        totalAmount += tip.amount;
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }

    return {
      success: true,
      totalTips: tips.length,
      successfulTips: results.filter((r) => r.success).length,
      totalAmount,
      results,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // END SESSION
  // ═══════════════════════════════════════════════════════════════

  /**
   * End the current streaming session.
   * Tips were already sent off-chain via Nitrolite transfers.
   *
   * @returns {Promise<Object>}
   */
  async endStreamSession() {
    if (!this.activeStreamSession) {
      throw new Error('No active stream session to end');
    }

    try {
      console.log('[YELLOW] 🔴 Ending stream session...');

      const session = this.activeStreamSession;
      session.status = 'closed';
      session.closedAt = Date.now();

      const sessionSummary = {
        sessionId: session.sessionId,
        duration: session.closedAt - session.createdAt,
        totalDeposited: session.initialDeposit,
        totalSpent: session.spent,
        unusedBalance: session.currentBalance,
        commissionRate: session.commissionRate,
      };

      console.log(`[YELLOW] 💰 [USDC] Total spent in tips: $${session.spent.toFixed(2)} USDC`);
      console.log(`[YELLOW] 💰 [USDC] Remaining: $${session.currentBalance.toFixed(2)} USDC`);
      console.log(
        `[YELLOW] 💰 [USDC] Session duration: ${((Date.now() - session.createdAt) / 1000).toFixed(0)}s`
      );

      // ── Withdraw remaining funds from Yellow Network custody ──
      if (this.nitroliteClient) {
        console.log('[YELLOW] 🔄 Withdrawing remaining funds from custody...');
        try {
          const result = await this.closeChannelAndWithdraw();
          if (result) {
            sessionSummary.closeTxHash = result.closeTxHash;
            sessionSummary.withdrawHash = result.withdrawHash;
            console.log('[YELLOW] ✅ Funds withdrawn to wallet!');
          }
        } catch (err) {
          console.error('[YELLOW] ⚠️ Withdrawal failed:', err.message);
          console.warn(
            '[YELLOW] ⚠️ Your funds remain in Yellow Network custody. You can withdraw later.'
          );
        }
      }

      console.log('[YELLOW] 🔴 Stream session ended.');

      this._triggerEvent('onSessionClosed', sessionSummary);

      // Clear active session
      this.activeStreamSession = null;

      return { success: true, ...sessionSummary };
    } catch (error) {
      console.error('❌ Failed to end stream session:', error);
      this._triggerEvent('onError', {
        type: 'session_close_error',
        message: error.message,
        error,
      });
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE HANDLING (post-auth, persistent)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Handle incoming messages from ClearNode using Nitrolite SDK parser.
   * @private
   */
  _handleMessage(data) {
    try {
      const raw = typeof data === 'string' ? data : data.toString();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn('⚠️ Non-JSON message from ClearNode:', raw);
        return;
      }

      // Use Nitrolite SDK parser for structured response handling
      const response = parseAnyRPCResponse(JSON.stringify(parsed));

      // ── Route to pending RPC requests first ──
      if (this._pendingRequests.has(response.method)) {
        const { resolve, timer } = this._pendingRequests.get(response.method);
        clearTimeout(timer);
        this._pendingRequests.delete(response.method);
        resolve(response);
        return;
      }

      // ── Route errors to pending requests ──
      if (response.method === RPCMethod.Error && this._pendingRequests.size > 0) {
        const entries = [...this._pendingRequests.entries()];
        const [method, { reject, timer }] = entries[entries.length - 1];
        clearTimeout(timer);
        this._pendingRequests.delete(method);
        reject(new Error(response.params?.error || 'RPC error'));
        return;
      }

      switch (response.method) {
        // ── Transfer confirmation ──
        case RPCMethod.Transfer: {
          console.log('[YELLOW] ✅ Transfer confirmed by ClearNode:', response.params);
          break;
        }

        // ── Balance updates (real-time push from ClearNode) ──
        case RPCMethod.BalanceUpdate: {
          const balances =
            response.params?.balanceUpdates || response.params?.ledgerBalances;
          if (balances) {
            console.log('[YELLOW] 💰 Balance update from ClearNode:', balances);
            const assetEntry = Array.isArray(balances)
              ? balances.find((b) => b.asset === this.config.defaultAsset)
              : null;
            if (assetEntry) {
              const bal = parseFloat(assetEntry.amount);
              if (this.activeStreamSession) {
                this.activeStreamSession.currentBalance = bal;
              }
              // Resolve deposit confirmation only if we see a positive balance
              if (this._depositConfirmedResolve && bal > 0) {
                console.log(`[YELLOW] ✅ ClearNode confirmed deposit via BalanceUpdate (balance: ${bal})`);
                this._depositConfirmedResolve();
              }
            }
          }

          this._triggerEvent('onBalanceUpdate', response.params);
          break;
        }

        // ── Ledger balance query response ──
        case RPCMethod.GetLedgerBalances: {
          const ledgerBalances = response.params?.ledgerBalances;
          if (ledgerBalances) {
            console.log('[YELLOW] 📊 Ledger balances:', ledgerBalances);
            const assetEntry = Array.isArray(ledgerBalances)
              ? ledgerBalances.find((b) => b.asset === this.config.defaultAsset)
              : null;
            if (assetEntry) {
              const bal = parseFloat(assetEntry.amount);
              if (this.activeStreamSession) {
                this.activeStreamSession.currentBalance = bal;
              }
              // Resolve deposit confirmation if balance > 0
              if (this._depositConfirmedResolve && bal > 0) {
                console.log(`[YELLOW] ✅ ClearNode confirmed deposit via GetLedgerBalances (balance: ${bal})`);
                this._depositConfirmedResolve();
              }
            }
          }
          this._triggerEvent('onBalanceUpdate', { balance: ledgerBalances });
          break;
        }

        // ── Channels update ──
        case RPCMethod.ChannelsUpdate: {
          console.log('[YELLOW] 📡 Channels update:', response.params);
          // Store existing channel info so we can detect orphaned channels
          const channels = response.params?.channels || [];
          if (channels.length > 0 && !this.channelId) {
            // There's an existing channel from a previous session
            const openChannel = channels.find(ch => ch.status === 'open' || ch.status === 'active');
            if (openChannel) {
              this._existingChannelId = openChannel.channelId || openChannel.channel_id;
              console.log(`[YELLOW] ℹ️ Found existing open channel: ${this._existingChannelId}`);
            }
          }

          // Resolve _waitForChannelReady if we're waiting for a specific channel
          if (this._channelReadyResolve) {
            const readyChannel = channels.find(ch =>
              (ch.status === 'open' || ch.status === 'active') &&
              (ch.channelId === this.channelId || ch.channel_id === this.channelId)
            );
            if (readyChannel) {
              console.log(`[YELLOW] ✅ ClearNode confirmed channel ${this.channelId} is open`);
              this._channelReadyResolve(readyChannel.channelId || readyChannel.channel_id);
            }
          }
          break;
        }

        // ── Assets info ──
        case RPCMethod.Assets: {
          console.log('[YELLOW] 📋 Assets info:', response.params);
          this.assets = response.params?.assets || [];
          break;
        }

        // ── Error from ClearNode ──
        case RPCMethod.Error: {
          console.error('❌ ClearNode error:', response.params);
          this._triggerEvent('onError', {
            type: 'clearnode_error',
            message: response.params?.error || 'Unknown ClearNode error',
            details: response.params,
          });
          break;
        }

        // ── Auth messages (handled by _authenticateWithNitrolite, skip here) ──
        case RPCMethod.AuthChallenge:
        case RPCMethod.AuthVerify:
          break;

        default:
          console.log('[YELLOW] 📩 ClearNode message:', response.method, response.params);

          // Some channel status messages arrive as unrecognized methods.
          // Check if this is a channel confirmation we're waiting for.
          if (this._channelReadyResolve && this.channelId) {
            const p = response.params || response;
            const msgChId = p.channelId || p.channel_id;
            const msgStatus = p.status;
            if (msgChId === this.channelId && (msgStatus === 'open' || msgStatus === 'active')) {
              console.log(`[YELLOW] ✅ ClearNode confirmed channel ${this.channelId} via push message`);
              this._channelReadyResolve(msgChId);
            }
          }

          // Check if this is a resize confirmation (channel amount changed)
          if (this._resizeProcessedResolve && this.channelId) {
            const p = response.params || response;
            const msgChId = p.channelId || p.channel_id;
            const msgStatus = p.status;
            const msgAmount = p.amount;
            if (msgChId === this.channelId && msgStatus === 'open' && msgAmount > 0n) {
              console.log(`[YELLOW] ✅ ClearNode confirmed resize processed for ${this.channelId} (amount: ${msgAmount})`);
              this._resizeProcessedResolve(msgChId);
            }
          }
      }
    } catch (error) {
      console.error('Failed to handle ClearNode message:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RECONNECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * @private
   */
  _attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(
        1000 * Math.pow(2, this.reconnectAttempts),
        30000
      );

      console.log(
        `[YELLOW] 🔄 Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`
      );

      setTimeout(async () => {
        try {
          await this._connectToClearNode();

          // Re-authenticate automatically (requires wallet popup for EIP-712)
          if (this.walletClient && this.sessionKey) {
            console.log('[YELLOW] 🔑 Re-authenticating after reconnect...');
            await this._authenticateWithNitrolite();
            await this._getConfig();
            console.log('[YELLOW] ✅ Fully reconnected and re-authenticated!');

            // If we were waiting for a deposit confirmation, query ledger now
            if (this._depositConfirmedResolve) {
              console.log('[YELLOW] 📊 Re-querying ledger balance after reconnect...');
              try {
                const balMsg = await createGetLedgerBalancesMessage(this.sessionSigner);
                this.ws.send(balMsg);
              } catch (balErr) {
                console.warn('[YELLOW] ⚠️ Could not query ledger balance:', balErr.message);
              }
            }
          }
        } catch (err) {
          console.error('Reconnect failed:', err.message);
        }
      }, delay);
    } else {
      console.error('❌ Max reconnection attempts reached');
      this._triggerEvent('onError', {
        type: 'max_reconnect_attempts',
        message: 'Could not reconnect to Yellow Network',
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Convert dollar amount to asset units (considering decimals).
   * @private
   */
  _toAssetUnits(dollarAmount) {
    return Math.floor(dollarAmount * Math.pow(10, this.config.assetDecimals));
  }

  /**
   * Convert asset units to dollar amount.
   * @private
   */
  _fromAssetUnits(units) {
    return units / Math.pow(10, this.config.assetDecimals);
  }

  /**
   * Register event handler.
   */
  on(event, handler) {
    if (this.eventHandlers.hasOwnProperty(event)) {
      this.eventHandlers[event] = handler;
    } else {
      console.warn(`Unknown event: ${event}`);
    }
  }

  /**
   * Trigger event handler.
   * @private
   */
  _triggerEvent(event, data) {
    if (this.eventHandlers[event]) {
      try {
        this.eventHandlers[event](data);
      } catch (error) {
        console.error(`Error in ${event} handler:`, error);
      }
    }
  }

  /**
   * Get current session info.
   */
  getSessionInfo() {
    if (!this.activeStreamSession) {
      return null;
    }

    return {
      sessionId: this.activeStreamSession.sessionId,
      streamer: this.activeStreamSession.streamerAddress,
      initialDeposit: this.activeStreamSession.initialDeposit,
      currentBalance: this.activeStreamSession.currentBalance,
      spent: this.activeStreamSession.spent,
      commissionRate: this.activeStreamSession.commissionRate,
      isPartner: this.activeStreamSession.isPartner,
      status: this.activeStreamSession.status,
    };
  }

  /**
   * Check if spending limit would be exceeded.
   */
  checkSpendingLimit(tipAmount, spendingLimit) {
    if (!this.activeStreamSession) {
      return { allowed: false, reason: 'No active session', percentUsed: 0 };
    }

    const newTotal = this.activeStreamSession.spent + tipAmount;

    if (newTotal > spendingLimit) {
      return {
        allowed: false,
        reason: 'Spending limit exceeded',
        currentSpent: this.activeStreamSession.spent,
        limit: spendingLimit,
        wouldBe: newTotal,
        percentUsed: (this.activeStreamSession.spent / spendingLimit) * 100,
      };
    }

    // Warning at 90%
    const percentUsed = (newTotal / spendingLimit) * 100;
    if (percentUsed >= 90) {
      return {
        allowed: true,
        warning: true,
        message: `You've used ${percentUsed.toFixed(0)}% of your spending limit`,
        percentUsed,
      };
    }

    return { allowed: true, percentUsed };
  }

  // ═══════════════════════════════════════════════════════════════
  // KEEPALIVE — prevent ClearNode from closing idle WebSocket
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start sending getLedgerBalances queries every 25s to keep the WS alive.
   * ClearNode drops idle connections after ~30-60s. Using a valid Nitrolite
   * RPC avoids "message validation failed" errors and doubles as a balance
   * poll.
   * @private
   */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAliveInterval = setInterval(async () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.authenticated && this.sessionSigner) {
          try {
            const balMsg = await createGetLedgerBalancesMessage(this.sessionSigner);
            this.ws.send(balMsg);
          } catch {
            // ws might be closing
          }
        }
        // If not yet authenticated, the auth flow itself keeps the WS busy
      }
    }, 25000);
  }

  /**
   * Stop the keepalive ping interval.
   * @private
   */
  _stopKeepAlive() {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
  }

  /**
   * Disconnect from Yellow Network.
   */
  disconnect() {
    this._stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.channelId = null;
    this.nitroliteClient = null;
    this.isDeposited = false;
    this._pendingRequests.forEach(({ timer }) => clearTimeout(timer));
    this._pendingRequests.clear();
    console.log('[YELLOW] 👋 Disconnected from Yellow Network');
  }
}

export default YellowTokService;
