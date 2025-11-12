import WebSocketFactory, { WebSocketLike } from './lib/websocket-factory'

import { PhoenixSocket } from './lib/phoenixAdapter'

import {
  CHANNEL_EVENTS,
  CONNECTION_STATE,
  DEFAULT_VERSION,
  DEFAULT_TIMEOUT,
  WS_CLOSE_NORMAL,
} from './lib/constants'

import { Timer } from 'phoenix'

import { httpEndpointURL } from './lib/transformers'
import RealtimeChannel from './RealtimeChannel'
import type { RealtimeChannelOptions } from './RealtimeChannel'

type Fetch = typeof fetch

export type Channel = {
  name: string
  inserted_at: string
  updated_at: string
  id: number
}
export type LogLevel = 'info' | 'warn' | 'error'

export type RealtimeMessage = {
  topic: string
  event: string
  payload: any
  ref: string
  join_ref?: string
}

export type RealtimeRemoveChannelResponse = 'ok' | 'timed out' | 'error'
export type HeartbeatStatus = 'sent' | 'ok' | 'error' | 'timeout' | 'disconnected'

const noop = () => {}

// Connection-related constants
const CONNECTION_TIMEOUTS = {
  HEARTBEAT_INTERVAL: 25000,
  RECONNECT_DELAY: 10,
  HEARTBEAT_TIMEOUT_FALLBACK: 100,
} as const

const RECONNECT_INTERVALS = [1000, 2000, 5000, 10000] as const
const DEFAULT_RECONNECT_FALLBACK = 10000

export interface WebSocketLikeConstructor {
  new (address: string | URL, subprotocols?: string | string[] | undefined): WebSocketLike
  // Allow additional properties that may exist on WebSocket constructors
  [key: string]: any
}

export interface WebSocketLikeError {
  error: any
  message: string
  type: string
}

export type RealtimeClientOptions = {
  transport?: WebSocketLikeConstructor
  timeout?: number
  heartbeatIntervalMs?: number
  logger?: Function
  encode?: Function
  decode?: Function
  reconnectAfterMs?: Function
  params?: { [key: string]: any }

  headers?: { [key: string]: string }
  //Deprecated: Use it in favour of correct casing `logLevel`
  log_level?: LogLevel
  logLevel?: LogLevel
  fetch?: Fetch
  worker?: boolean
  workerUrl?: string
  accessToken?: () => Promise<string | null>
  heartbeatCallback?: (status: HeartbeatStatus) => void
}

// TODO: Use WORKER_SCRIPT
const WORKER_SCRIPT = `
  addEventListener("message", (e) => {
    if (e.data.event === "start") {
      setInterval(() => postMessage({ event: "keepAlive" }), e.data.interval);
    }
  });`

export default class RealtimeClient {
  socket: PhoenixSocket
  accessTokenValue: string | null = null
  apiKey: string | null = null
  channels: RealtimeChannel[] = new Array()
  // endPoint: string = '' // It is done in PhoenixSocket
  httpEndpoint: string = ''
  /** @deprecated headers cannot be set on websocket connections */
  headers?: { [key: string]: string } = {}
  params?: { [key: string]: string } = {}
  timeout: number = DEFAULT_TIMEOUT
  transport: WebSocketLikeConstructor | null = null
  heartbeatIntervalMs: number = CONNECTION_TIMEOUTS.HEARTBEAT_INTERVAL
  heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined
  pendingHeartbeatRef: string | null = null
  heartbeatCallback: (status: HeartbeatStatus) => void = noop
  ref: number = 0
  reconnectTimer: Timer | null = null
  logLevel?: LogLevel
  reconnectAfterMs!: Function
  fetch: Fetch
  accessToken: (() => Promise<string | null>) | null = null
  worker?: boolean
  workerUrl?: string
  workerRef?: Worker
  // private _connectionState: RealtimeClientState = 'disconnected' // Probably not needed
  private _wasManualDisconnect: boolean = false
  private _authPromise: Promise<void> | null = null

  /**
   * Initializes the Socket.
   *
   * @param endPoint The string WebSocket endpoint, ie, "ws://example.com/socket", "wss://example.com", "/socket" (inherited host & protocol)
   * @param httpEndpoint The string HTTP endpoint, ie, "https://example.com", "/" (inherited host & protocol)
   * @param options.transport The Websocket Transport, for example WebSocket. This can be a custom implementation
   * @param options.timeout The default timeout in milliseconds to trigger push timeouts.
   * @param options.params The optional params to pass when connecting.
   * @param options.headers Deprecated: headers cannot be set on websocket connections and this option will be removed in the future.
   * @param options.heartbeatIntervalMs The millisec interval to send a heartbeat message.
   * @param options.heartbeatCallback The optional function to handle heartbeat status.
   * @param options.logger The optional function for specialized logging, ie: logger: (kind, msg, data) => { console.log(`${kind}: ${msg}`, data) }
   * @param options.logLevel Sets the log level for Realtime
   * @param options.encode The function to encode outgoing messages. Defaults to JSON: (payload, callback) => callback(JSON.stringify(payload))
   * @param options.decode The function to decode incoming messages. Defaults to Serializer's decode.
   * @param options.reconnectAfterMs he optional function that returns the millsec reconnect interval. Defaults to stepped backoff off.
   * @param options.worker Use Web Worker to set a side flow. Defaults to false.
   * @param options.workerUrl The URL of the worker script. Defaults to https://realtime.supabase.com/worker.js that includes a heartbeat event call to keep the connection alive.
   */
  constructor(endPoint: string, options?: RealtimeClientOptions) {
    // Validate required parameters
    if (!options?.params?.apikey) {
      throw new Error('API key is required to connect to Realtime')
    }
    this.apiKey = options.params.apikey

    this._initializeOptions(options)
    this._setupReconnectionTimer()
    this.fetch = this._resolveFetch(options?.fetch)

    this.socket = new PhoenixSocket(endPoint, options)

    this.httpEndpoint = httpEndpointURL(this.socket.endPointURL()) // Moved after creating PhoenixSocket
  }

  /**
   * Connects the socket, unless already connected.
   */
  connect(): void {
    // // Skip if already connecting, disconnecting, or connected
    if (
      this.isConnecting() ||
      this.isDisconnecting() ||
      (this.socket && this.socket.isConnected())
    ) {
      return
    }

    // Trigger auth if needed and not already in progress
    // This ensures auth is called for standalone RealtimeClient usage
    // while avoiding race conditions with SupabaseClient's immediate setAuth call
    if (this.accessToken && !this._authPromise) {
      this._setAuthSafely('connect')
    }

    this.socket.connect()
  }

  /**
   * Returns the URL of the websocket.
   * @returns string The URL of the websocket.
   */
  endpointURL(): string {
    return this.socket.endPointURL()
  }

  /**
   * Disconnects the socket.
   *
   * @param code A numeric status code to send on disconnect.
   * @param reason A custom reason for the disconnect.
   */
  disconnect(code?: number, reason?: string): void {
    if (this.isDisconnecting()) {
      return
    }

    this.socket.disconnect(code, reason)
  }

  /**
   * Returns all created channels
   */
  getChannels(): RealtimeChannel[] {
    return this.channels
  }

  /**
   * Unsubscribes and removes a single channel
   * @param channel A RealtimeChannel instance
   */
  async removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse> {
    // TODO: It might need to use `remove` method from socket
    const status = await channel.unsubscribe()

    if (this.channels.length === 0) {
      this.disconnect()
    }

    return status
  }

  /**
   * Unsubscribes and removes all channels
   */
  async removeAllChannels(): Promise<RealtimeRemoveChannelResponse[]> {
    // TODO: It might need to use `remove` method from socket
    const values_1 = await Promise.all(this.channels.map((channel) => channel.unsubscribe()))
    this.channels = []
    this.disconnect()
    return values_1
  }

  /**
   * Logs the message.
   *
   * For customized logging, `this.logger` can be overridden.
   */
  log(kind: string, msg: string, data?: any) {
    this.socket.log(kind, msg, data)
  }

  /**
   * Returns the current state of the socket.
   */
  connectionState(): CONNECTION_STATE {
    return (this.socket && this.socket.connectionState()) || CONNECTION_STATE.Closed
  }

  /**
   * Returns `true` is the connection is open.
   */
  isConnected(): boolean {
    return this.socket && this.socket.isConnected()
  }

  /**
   * Returns `true` if the connection is currently connecting.
   */
  isConnecting(): boolean {
    return this.socket && this.socket.isConnecting()
  }

  /**
   * Returns `true` if the connection is currently disconnecting.
   */
  isDisconnecting(): boolean {
    return this.socket && this.socket.isDisconnecting()
  }

  channel(topic: string, params: RealtimeChannelOptions = { config: {} }): RealtimeChannel {
    const realtimeTopic = `realtime:${topic}`
    const exists = this.getChannels().find((c: RealtimeChannel) => c.topic === realtimeTopic)

    if (!exists) {
      const chan = new RealtimeChannel(`realtime:${topic}`, params, this)
      this.channels.push(chan)

      return chan
    } else {
      return exists
    }
  }

  /**
   * Push out a message if the socket is connected.
   *
   * If the socket is not connected, the message gets enqueued within a local buffer, and sent out when a connection is next established.
   */
  push(data: RealtimeMessage): void {
    this.socket.push(data)
  }

  /**
   * Sets the JWT access token used for channel subscription authorization and Realtime RLS.
   *
   * If param is null it will use the `accessToken` callback function or the token set on the client.
   *
   * On callback used, it will set the value of the token internal to the client.
   *
   * @param token A JWT string to override the token set on the client.
   */
  async setAuth(token: string | null = null): Promise<void> {
    this._authPromise = this._performAuth(token)
    try {
      await this._authPromise
    } finally {
      this._authPromise = null
    }
  }
  /**
   * Sends a heartbeat message if the socket is connected.
   */
  async sendHeartbeat() {
    if (!this.isConnected()) {
      try {
        this.heartbeatCallback('disconnected')
      } catch (e) {
        this.log('error', 'error in heartbeat callback', e)
      }
      return
    }

    // Handle heartbeat timeout and force reconnection if needed
    if (this.pendingHeartbeatRef) {
      this.pendingHeartbeatRef = null
      this.log('transport', 'heartbeat timeout. Attempting to re-establish connection')
      try {
        this.heartbeatCallback('timeout')
      } catch (e) {
        this.log('error', 'error in heartbeat callback', e)
      }

      // Force reconnection after heartbeat timeout
      this._wasManualDisconnect = false
      // TODO: This might not work IDK
      this.socket.disconnect(WS_CLOSE_NORMAL, 'heartbeat timeout')
      // this.conn?.close(WS_CLOSE_NORMAL, 'heartbeat timeout')

      setTimeout(() => {
        if (!this.isConnected()) {
          this.reconnectTimer?.scheduleTimeout()
        }
      }, CONNECTION_TIMEOUTS.HEARTBEAT_TIMEOUT_FALLBACK)
      return
    }

    // Send heartbeat message to server
    this.pendingHeartbeatRef = this._makeRef()
    this.push({
      topic: 'phoenix',
      event: 'heartbeat',
      payload: {},
      ref: this.pendingHeartbeatRef,
    })
    try {
      this.heartbeatCallback('sent')
    } catch (e) {
      this.log('error', 'error in heartbeat callback', e)
    }

    this._setAuthSafely('heartbeat')
  }

  onHeartbeat(callback: (status: HeartbeatStatus) => void): void {
    this.heartbeatCallback = callback
  }

  /**
   * Use either custom fetch, if provided, or default fetch to make HTTP requests
   *
   * @internal
   */
  _resolveFetch = (customFetch?: Fetch): Fetch => {
    let _fetch: Fetch
    if (customFetch) {
      _fetch = customFetch
    } else if (typeof fetch === 'undefined') {
      // Node.js environment without native fetch
      _fetch = (...args) =>
        import('@supabase/node-fetch' as any)
          .then(({ default: fetch }) => fetch(...args))
          .catch((error) => {
            throw new Error(
              `Failed to load @supabase/node-fetch: ${error.message}. ` +
                `This is required for HTTP requests in Node.js environments without native fetch.`
            )
          })
    } else {
      _fetch = fetch
    }
    return (...args) => _fetch(...args)
  }

  /**
   * Return the next message ref, accounting for overflows
   *
   * @internal
   */
  _makeRef(): string {
    let newRef = this.ref + 1
    if (newRef === this.ref) {
      this.ref = 0
    } else {
      this.ref = newRef
    }

    return this.ref.toString()
  }

  /**
   * Removes a subscription from the socket.
   *
   * @param channel An open subscription.
   *
   * @internal
   */
  _remove(channel: RealtimeChannel) {
    // TODO: It might need to unsubscribe the channel first before removing it.
    this.channels = this.channels.filter((c) => c.topic !== channel.topic)
  }

  /**
   * Perform the actual auth operation
   * @internal
   */
  private async _performAuth(token: string | null = null): Promise<void> {
    let tokenToSend: string | null

    if (token) {
      tokenToSend = token
    } else if (this.accessToken) {
      // Always call the accessToken callback to get fresh token
      tokenToSend = await this.accessToken()
    } else {
      tokenToSend = this.accessTokenValue
    }

    this.log('auth', 'performing auth', { token: tokenToSend })

    if (this.accessTokenValue != tokenToSend) {
      this.accessTokenValue = tokenToSend
      this.channels.forEach((channel) => {
        const payload = {
          access_token: tokenToSend,
          version: DEFAULT_VERSION,
        }

        tokenToSend && channel.updateJoinPayload(payload)

        // TODO: Try catch trick. Maybe it is not needed.
        // Cannot access joinedOnce. If exposed there could be check instead of try.
        try {
          channel.phoenixChannel.push(CHANNEL_EVENTS.access_token, {
            access_token: tokenToSend,
          })
          this.log('auth', 'pushed access token', { token: tokenToSend })
        } catch (e) {
          this.log('auth', 'error pushing access token', e)
        }
      })
    }
  }

  /**
   * Wait for any in-flight auth operations to complete
   * @internal
   */
  private async _waitForAuthIfNeeded(): Promise<void> {
    if (this._authPromise) {
      await this._authPromise
    }
  }

  /**
   * Safely call setAuth with standardized error handling
   * @internal
   */
  private _setAuthSafely(context = 'general'): void {
    this.setAuth().catch((e) => {
      this.log('error', `error setting auth in ${context}`, e)
    })
  }

  /**
   * Setup reconnection timer with proper configuration
   * @internal
   */
  private _setupReconnectionTimer(): void {
    this.reconnectTimer = new Timer(async () => {
      setTimeout(async () => {
        await this._waitForAuthIfNeeded()
        if (!this.isConnected()) {
          this.connect()
        }
      }, CONNECTION_TIMEOUTS.RECONNECT_DELAY)
    }, this.reconnectAfterMs)
  }

  /**
   * Initialize client options with defaults
   * @internal
   */
  private _initializeOptions(options?: RealtimeClientOptions): void {
    // Set defaults
    this.transport = options?.transport ?? null
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT
    this.heartbeatIntervalMs =
      options?.heartbeatIntervalMs ?? CONNECTION_TIMEOUTS.HEARTBEAT_INTERVAL
    this.worker = options?.worker ?? false
    this.accessToken = options?.accessToken ?? null
    this.heartbeatCallback = options?.heartbeatCallback ?? noop

    // Handle special cases
    if (options?.params) this.params = options.params
    // if (options?.logger) this.logger = options.logger // Part of PhoenixSocket
    if (options?.logLevel || options?.log_level) {
      this.logLevel = options.logLevel || options.log_level
      this.params = { ...this.params, log_level: this.logLevel as string }
    }

    // Set up functions with defaults
    this.reconnectAfterMs =
      options?.reconnectAfterMs ??
      ((tries: number) => {
        return RECONNECT_INTERVALS[tries - 1] || DEFAULT_RECONNECT_FALLBACK
      })

    // Handle worker setup
    if (this.worker) {
      if (typeof window !== 'undefined' && !window.Worker) {
        throw new Error('Web Worker is not supported')
      }
      this.workerUrl = options?.workerUrl
    }
  }
}
