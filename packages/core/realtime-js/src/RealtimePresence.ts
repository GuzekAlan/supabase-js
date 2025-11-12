/*
  This file draws heavily from https://github.com/phoenixframework/phoenix/blob/d344ec0a732ab4ee204215b31de69cf4be72e3bf/assets/js/phoenix/presence.js
  License: https://github.com/phoenixframework/phoenix/blob/d344ec0a732ab4ee204215b31de69cf4be72e3bf/LICENSE.md
*/

// TODO: This does not work with the new implementation. Uncomment and fix the code.

// import type { PresenceOpts, PresenceOnJoinCallback, PresenceOnLeaveCallback } from 'phoenix'
import type RealtimeChannel from './RealtimeChannel'
import { PhoenixPresence, PresenceOpts } from './lib/phoenixAdapter'

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

type Presence<T extends { [key: string]: any } = {}> = {
  presence_ref: string
} & T

export type RealtimePresenceState<T extends { [key: string]: any } = {}> = {
  [key: string]: Presence<T>[]
}

export type RealtimePresenceJoinPayload<T extends { [key: string]: any }> = {
  event: `${REALTIME_PRESENCE_LISTEN_EVENTS.JOIN}`
  key: string
  currentPresences: Presence<T>[]
  newPresences: Presence<T>[]
}

export type RealtimePresenceLeavePayload<T extends { [key: string]: any }> = {
  event: `${REALTIME_PRESENCE_LISTEN_EVENTS.LEAVE}`
  key: string
  currentPresences: Presence<T>[]
  leftPresences: Presence<T>[]
}

export enum REALTIME_PRESENCE_LISTEN_EVENTS {
  SYNC = 'sync',
  JOIN = 'join',
  LEAVE = 'leave',
}

type PresenceDiff = {
  joins: RealtimePresenceState
  leaves: RealtimePresenceState
}

type RawPresenceState = {
  [key: string]: {
    metas: {
      phx_ref?: string
      phx_ref_prev?: string
      [key: string]: any
    }[]
  }
}

type RawPresenceDiff = {
  joins: RawPresenceState
  leaves: RawPresenceState
}

type PresenceChooser<T> = (key: string, presences: Presence[]) => T

export default class RealtimePresence {
  private presence: PhoenixPresence

  /**
   * Initializes the Presence.
   *
   * @param channel - The RealtimeChannel
   * @param opts - The options,
   *        for example `{events: {state: 'state', diff: 'diff'}}`
   */
  constructor(
    public channel: RealtimeChannel,
    opts?: PresenceOpts
  ) {
    this.presence = new PhoenixPresence(channel.phoenixChannel, opts)

    this.presence.onJoin((key: any, currentPresences: any, newPresences: any) => {
      this.channel._trigger('presence', {
        event: 'join',
        key,
        currentPresences,
        newPresences,
      })
    })

    this.presence.onLeave((key: any, currentPresences: any, leftPresences: any) => {
      this.channel._trigger('presence', {
        event: 'leave',
        key,
        currentPresences,
        leftPresences,
      })
    })

    this.presence.onSync(() => {
      this.channel._trigger('presence', { event: 'sync' })
    })
  }

  // TODO: Fix typing
  state(): any {
    return this.presence.state()
  }
}
