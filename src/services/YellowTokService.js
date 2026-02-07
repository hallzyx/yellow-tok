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
  parseAnyRPCResponse,
  RPCMethod,
} from '@erc7824/nitrolite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';

class YellowTokService {
  constructor(config = {}) {
    // Configuration
    this.config = {
      clearnodeUrl: config.clearnodeUrl || 'wss://clearnet-sandbox.yellow.com/ws',
      standardCommission: config.standardCommission || 10,
      partnerCommission: config.partnerCommission || 3,
      defaultAsset: config.defaultAsset || 'ytest.usd',
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

    // Event callbacks
    this.eventHandlers = {
      onConnected: null,
      onDisconnected: null,
      onSessionCreated: null,
      onTipReceived: null,
      onTipSent: null,
      onBalanceUpdate: null,
      onSessionClosed: null,
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
  async initialize(walletProvider, walletClient) {
    try {
      console.log('[YELLOW] 🚀 Initializing YellowTok Service...');

      // 1. Get user address from provider
      const { userAddress } = await this._setupWallet(walletProvider);
      this.userAddress = userAddress;
      this.walletClient = walletClient;

      console.log('[YELLOW] 👛 Wallet connected:', userAddress);

      // 2. Generate or restore ephemeral session key
      this._initSessionKey();
      console.log('[YELLOW] 🔑 Session key:', this.sessionKey.address);

      // 3. Connect WebSocket to ClearNode
      await this._connectToClearNode();

      // 4. Authenticate via Nitrolite (EIP-712 challenge-response)
      //    This is the ONLY wallet popup — after this, session key signs everything.
      await this._authenticateWithNitrolite();

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
        `[LOCAL] ✅ Tip sent! Creator receives $${creatorReceives.toFixed(2)} USDC (${this.activeStreamSession.commissionRate}% commission)`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Remaining: $${this.activeStreamSession.currentBalance.toFixed(2)} | Spent: $${this.activeStreamSession.spent.toFixed(2)}`
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
      console.log('[LOCAL] 🔴 Ending stream session...');

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

      console.log('[LOCAL] 🔴 Stream session ended.');
      console.log(
        `[LOCAL] 💰 [USDC] Final balance: $${session.currentBalance.toFixed(2)} USDC (unused)`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Total spent in tips: $${session.spent.toFixed(2)} USDC`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Initial deposit was: $${session.initialDeposit.toFixed(2)} USDC`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Session duration: ${((Date.now() - session.createdAt) / 1000).toFixed(0)}s`
      );

      console.log('[LOCAL] 🔴 Stream session ended.');
      console.log(
        `[YELLOW] 💰 [YTEST.USD] Final balance: $${session.currentBalance.toFixed(2)} (unused)`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Total spent in tips: $${session.spent.toFixed(2)} USDC`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Initial deposit was: $${session.initialDeposit.toFixed(2)} USDC`
      );
      console.log(
        `[LOCAL] 💰 [USDC] Session duration: ${((Date.now() - session.createdAt) / 1000).toFixed(0)}s`
      );

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
            if (assetEntry && this.activeStreamSession) {
              this.activeStreamSession.currentBalance = parseFloat(
                assetEntry.amount
              );
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
          }
          this._triggerEvent('onBalanceUpdate', { balance: ledgerBalances });
          break;
        }

        // ── Channels update ──
        case RPCMethod.ChannelsUpdate: {
          console.log('[YELLOW] 📡 Channels update:', response.params);
          break;
        }

        // ── Assets info ──
        case RPCMethod.Assets: {
          console.log('[YELLOW] 📋 Assets info:', response.params);
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

      setTimeout(() => {
        this._connectToClearNode().catch((err) => {
          console.error('Reconnect failed:', err);
        });
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

  /**
   * Disconnect from Yellow Network.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    console.log('[YELLOW] 👋 Disconnected from Yellow Network');
  }
}

export default YellowTokService;
