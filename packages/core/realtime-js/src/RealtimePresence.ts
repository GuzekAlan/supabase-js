/*
  This file draws heavily from https://github.com/phoenixframework/phoenix/blob/d344ec0a732ab4ee204215b31de69cf4be72e3bf/assets/js/phoenix/presence.js
  License: https://github.com/phoenixframework/phoenix/blob/d344ec0a732ab4ee204215b31de69cf4be72e3bf/LICENSE.md
*/

import type RealtimeChannel from './RealtimeChannel'
import { PhoenixPresence, PresenceOpts, RawPresenceState } from './lib/phoenixAdapter'

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

    this.presence.onJoin((key, currentPresences, newPresences) => {
      this.channel._trigger('presence', {
        event: 'join',
        key,
        currentPresences,
        newPresences,
      })
    })

    this.presence.onLeave((key, currentPresences, leftPresences) => {
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

  state(): RealtimePresenceState {
    return RealtimePresence.transformState(this.presence.state())
  }

  /**
   * Remove 'metas' key
   * Change 'phx_ref' to 'presence_ref'
   * Remove 'phx_ref' and 'phx_ref_prev'
   *
   * @example
   * // returns {
   *  abc123: [
   *    { presence_ref: '2', user_id: 1 },
   *    { presence_ref: '3', user_id: 2 }
   *  ]
   * }
   * RealtimePresence.transformState({
   *  abc123: {
   *    metas: [
   *      { phx_ref: '2', phx_ref_prev: '1' user_id: 1 },
   *      { phx_ref: '3', user_id: 2 }
   *    ]
   *  }
   * })
   *
   * @internal
   */
  private static transformState(state: RawPresenceState): RealtimePresenceState {
    state = this.cloneDeep(state)

    return Object.getOwnPropertyNames(state).reduce((newState, key) => {
      const presences = state[key]

      if ('metas' in presences) {
        newState[key] = presences.metas.map((presence) => {
          presence['presence_ref'] = presence['phx_ref']

          delete presence['phx_ref']
          delete presence['phx_ref_prev']

          return presence
        }) as Presence[]
      } else {
        newState[key] = presences
      }

      return newState
    }, {} as RealtimePresenceState)
  }

  /** @internal */
  private static cloneDeep(obj: { [key: string]: any }) {
    return JSON.parse(JSON.stringify(obj))
  }
}
