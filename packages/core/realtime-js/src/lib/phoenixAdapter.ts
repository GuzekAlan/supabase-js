import { Channel, Socket, Push } from 'phoenix'
import { CONNECTION_STATE, CHANNEL_STATES } from './constants'
import { RealtimeChannelOptions } from '../RealtimeChannel'
import { Presence } from 'phoenix'

export type SocketConnectOption = {
  params?: object
  transport?: Function
  timeout?: number
  heartbeatIntervalMs?: number
  logger?: Function
  encode?: Function
  decode?: Function
  reconnectAfterMs?: number
}

export type RawPresenceState = {
  [key: string]: {
    metas: {
      phx_ref?: string
      phx_ref_prev?: string
      [key: string]: any
    }[]
  }
}

export type PhoenixSocketOptions = {
  params: { [key: string]: string }
  transport?: Function
  timeout: number
  heartbeatIntervalMs: number
  logger?: Function
  encode?: Function
  decode?: Function
  reconnectAfterMs: Function
  heartbeatEnabled: boolean
}

type PhoenixBinding = { event: string; ref: number; callback: Function }

export class PhoenixSocket {
  private socket: Socket

  constructor(endPoint: string, options: PhoenixSocketOptions) {
    // options.heartbeatIntervalMs = 1000000000
    this.socket = new Socket(endPoint, options)
  }

  connect(): void {
    this.socket.connect()
  }

  isConnected(): boolean {
    return this.socket.isConnected()
  }

  isConnecting(): boolean {
    return this.socket.connectionState() === CONNECTION_STATE.Connecting
  }

  isDisconnecting(): boolean {
    return this.socket.connectionState() === CONNECTION_STATE.Closing
  }

  disconnect(code: number | undefined, reason: string | undefined): void {
    this.socket.disconnect(() => {}, code, reason)
  }

  log(kind: string, msg: string, data?: any): void {
    this.socket.log(kind, msg, data)
  }

  push(data: object): void {
    this.socket.push(data)
  }

  connectionState(): CONNECTION_STATE {
    return this.socket.connectionState() as CONNECTION_STATE
  }

  endPointURL(): string {
    return this.socket.endPointURL()
  }

  onOpen(callback: Function): void {
    this.socket.onOpen(callback)
  }

  onClose(callback: Function): void {
    this.socket.onClose(callback)
  }

  onError(callback: Function): void {
    this.socket.onError(callback)
  }

  onMessage(callback: Function): void {
    this.socket.onMessage(callback)
  }

  makeRef(): string {
    return this.socket.makeRef()
  }

  /**
   * @private
   * @returns {Channel} A new Phoenix channel instance
   */
  channel(topic: string, params: object | undefined): Channel {
    return this.socket.channel(topic, params)
  }
}

export class PhoenixChannel {
  private channel: Channel
  private socket: PhoenixSocket

  constructor(socket: PhoenixSocket, topic: string, params: RealtimeChannelOptions) {
    // Transform RealtimeChannelOptions to Phoenix channel params
    const phoenixParams = translateRealtimeOptionsToChannelParams(params)
    // TODO: Figure out some decoupling to not expose `socket.channel` publicly
    this.channel = socket.channel(topic, phoenixParams)
    this.socket = socket
  }

  on(event: string, callback: Function): number {
    return this.channel.on(event, callback)
  }

  off(event: string, refNumber?: number): void {
    this.channel.off(event, refNumber)
  }

  trigger(type: string, payload: object, ref?: string): void {
    this.channel.trigger(type, payload, ref, this.channel.joinRef())
  }

  updateFilterMessage(
    filterMessage: (
      event: string,
      payload: object,
      ref: number | undefined,
      bind: PhoenixBinding
    ) => boolean
  ): void {
    this.channel.filterMessage = filterMessage
  }

  subscribe(timeout?: number | undefined): Push {
    this.channel.joinedOnce = false // Reset joinedOnce flag to allow multiple joins
    return this.channel.join(timeout)
  }

  unsubscribe(timeout?: number | undefined): Push {
    return this.channel.leave(timeout)
  }

  send(event: string, payload: object, timeout?: number | undefined): void {
    this.channel.push(event, payload, timeout)
  }

  push(event: string, payload: { [key: string]: any }, timeout?: number | undefined): Push {
    try {
      return this.channel.push(event, payload, timeout)
    } catch (error) {
      throw `tried to push '${event}' to '${this.channel.topic}' before joining. Use channel.subscribe() before pushing events`
    }
  }
  canSend(): boolean {
    return this.socket.isConnected() && this.state() === CHANNEL_STATES.joined
  }

  joinRef(): string {
    return this.channel.joinRef()
  }

  setState(state: CHANNEL_STATES): void {
    this.channel.state = state as CHANNEL_STATES
  }

  updateJoinPayload(payload: { [key: string]: any }): void {
    this.channel.updateJoinPayload(payload)
  }

  state(): CHANNEL_STATES {
    return this.channel.state as CHANNEL_STATES
  }

  /**
   * @private
   * @returns {Presence} A new Presence instance
   */
  presence(opts?: PresenceOpts): Presence {
    return new Presence(this.channel, opts)
  }
}

/**
 * Translates Supabase RealtimeChannelOptions to Phoenix channel params format
 * Phoenix expects a flat params object with config properties
 */
function translateRealtimeOptionsToChannelParams(options: RealtimeChannelOptions): object {
  options.config = {
    ...{
      broadcast: { ack: false, self: false },
      presence: { key: '', enabled: false },
      private: false,
    },
    ...options.config,
  }

  return options
}

// Presence options for events names
export type PresenceOpts = {
  events: {
    state: string
    diff: string
  }
}

type PresenceOnJoinCallback = (
  key: string,
  currentPresences: Presence[],
  newPresences: Presence[]
) => void

type PresenceOnLeaveCallback = (
  key: string,
  currentPresences: Presence[],
  leftPresences: Presence[]
) => void

export class PhoenixPresence {
  private presence: Presence

  constructor(channel: PhoenixChannel, opts?: PresenceOpts) {
    this.presence = channel.presence(opts)
  }

  onJoin(callback: PresenceOnJoinCallback): void {
    this.presence.onJoin(callback)
  }

  onLeave(callback: PresenceOnLeaveCallback): void {
    this.presence.onLeave(callback)
  }

  onSync(callback: () => void): void {
    this.presence.onSync(callback)
  }

  state(): RawPresenceState {
    return this.presence.state
  }
}
