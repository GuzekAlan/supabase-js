import { useEffect, useState, useRef } from 'react'
import { RealtimeClient } from '@supabase/realtime-js'
import { createClient } from '@supabase/supabase-js'
import {
  NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_REALTIME_URL,
  NEXT_PUBLIC_SUPABASE_KEY,
  NEXT_PUBLIC_TEST_USER_EMAIL,
  NEXT_PUBLIC_TEST_USER_PASSWORD,
} from '../lib/constants'

export default function IndexPage() {
  // Socket and client state
  const socketRef = useRef(null)
  const supabaseRef = useRef(null)
  const [socketStatus, setSocketStatus] = useState('closed')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [userId, setUserId] = useState(null)

  // Auth form state
  const [email, setEmail] = useState(NEXT_PUBLIC_TEST_USER_EMAIL || '')
  const [password, setPassword] = useState('')

  // Channel management state
  const channelsRef = useRef(new Map())
  const [activeChannels, setActiveChannels] = useState([])
  const [channelName, setChannelName] = useState('')
  const [channelType, setChannelType] = useState('public')
  const [enablePresence, setEnablePresence] = useState(true)
  const [enableBroadcast, setEnableBroadcast] = useState(true)
  const [broadcastAck, setBroadcastAck] = useState(true)
  const [broadcastSelf, setBroadcastSelf] = useState(true)
  const [postgresChangesEnabled, setPostgresChangesEnabled] = useState(false)

  // Postgres changes state
  const [pgSchema, setPgSchema] = useState('public')
  const [pgTable, setPgTable] = useState('')
  const [pgEvent, setPgEvent] = useState('*')

  // Broadcast message state
  const [broadcastEvent, setBroadcastEvent] = useState('message')
  const [broadcastPayload, setBroadcastPayload] = useState('')

  // Presence state
  const [presenceKey, setPresenceKey] = useState('')
  const [presencePayload, setPresencePayload] = useState('')

  // Data tables
  const [broadcastMessages, setBroadcastMessages] = useState([])
  const [postgresChanges, setPostgresChanges] = useState([])
  const [presenceState, setPresenceState] = useState({})

  // Initialize socket and supabase client
  useEffect(() => {
    const socket = new RealtimeClient(NEXT_PUBLIC_REALTIME_URL, {
      params: { apikey: NEXT_PUBLIC_SUPABASE_KEY },
      logger: (kind, msg, data) => {
        console.log(`[${kind.toUpperCase()}] ${msg}`, data)
      },
    })

    socketRef.current = socket
    supabaseRef.current = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_KEY)

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [])

  // Monitor WebSocket connection status changes
  useEffect(() => {
    if (!socketRef.current) return

    const socket = socketRef.current

    const updateStatus = () => {
      if (socket.isConnecting()) {
        setSocketStatus('connecting')
      } else if (socket.isConnected()) {
        setSocketStatus('open')
      } else if (socket.isDisconnecting()) {
        setSocketStatus('closing')
      } else {
        setSocketStatus('closed')
      }
    }

    // Check status periodically
    const interval = setInterval(updateStatus, 500)
    updateStatus()

    return () => clearInterval(interval)
  }, [])

  // Authentication
  const handleLogin = async () => {
    if (!email || !password) return

    try {
      const { data, error } = await supabaseRef.current.auth.signInWithPassword({
        email,
        password,
      })

      if (error) return

      if (data?.session) {
        const authToken = data.session.access_token
        setUserId(data.user.id)
        setIsAuthenticated(true)
        await socketRef.current.setAuth(authToken)
      }
    } catch (error) {
      console.error('Login error:', error)
    }
  }

  const handleLogout = async () => {
    try {
      await supabaseRef.current.auth.signOut()
      setIsAuthenticated(false)
      setUserId(null)
      setEmail('')
      setPassword('')

      // Unsubscribe from all channels
      channelsRef.current.forEach((channel) => {
        channel.unsubscribe()
      })
      channelsRef.current.clear()
      setActiveChannels([])
    } catch (error) {
      console.error('Logout error:', error)
    }
  }

  // Connection management
  const toggleConnection = () => {
    if (socketStatus === 'open') {
      socketRef.current.disconnect()
    } else {
      socketRef.current.connect()
    }
  }

  // Channel management
  const createChannel = () => {
    if (!channelName.trim()) return

    const fullChannelName = channelType === 'private' ? `private:${channelName}` : channelName

    if (channelsRef.current.has(fullChannelName)) return

    const channelConfig = {
      config: {
        private: channelType === 'private',
        broadcast: enableBroadcast ? { ack: broadcastAck, self: broadcastSelf } : undefined,
        presence: enablePresence ? { key: presenceKey || userId || '' } : undefined,
      },
    }

    // Add postgres_changes to initial config if enabled
    if (postgresChangesEnabled && pgTable.trim()) {
      channelConfig.config.postgres_changes = [
        {
          event: pgEvent,
          schema: pgSchema,
          table: pgTable,
        },
      ]
    }

    const channel = socketRef.current.channel(fullChannelName, channelConfig)

    // Set up broadcast listener
    if (enableBroadcast) {
      channel.on('broadcast', { event: '*' }, ({ event, payload }) => {
        setBroadcastMessages((prev) => [
          ...prev,
          {
            timestamp: new Date().toISOString(),
            channel: fullChannelName,
            event,
            payload,
          },
        ])
      })
    }

    // Set up presence listeners
    if (enablePresence) {
      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        setPresenceState((prev) => ({
          ...prev,
          [fullChannelName]: state,
        }))
      })

      channel.on('presence', { event: 'join' }, () => {
        setPresenceState((prev) => ({
          ...prev,
          [fullChannelName]: channel.presenceState(),
        }))
      })

      channel.on('presence', { event: 'leave' }, () => {
        setPresenceState((prev) => ({
          ...prev,
          [fullChannelName]: channel.presenceState(),
        }))
      })
    }

    // Set up postgres_changes listener if enabled in initial config
    if (postgresChangesEnabled && pgTable.trim()) {
      channel.on(
        'postgres_changes',
        { event: pgEvent, schema: pgSchema, table: pgTable },
        (payload) => {
          setPostgresChanges((prev) => [
            ...prev,
            {
              timestamp: new Date().toISOString(),
              channel: fullChannelName,
              ...payload,
            },
          ])
        }
      )
    }

    channelsRef.current.set(fullChannelName, channel)
    updateActiveChannels()
  }

  const subscribeToChannel = (channelName) => {
    const channel = channelsRef.current.get(channelName)
    if (!channel) return

    channel.subscribe((status, err) => {
      if (!err && status === 'SUBSCRIBED' && enablePresence) {
        const trackPayload = presencePayload
          ? JSON.parse(presencePayload)
          : { online_at: new Date().toISOString() }

        channel.track(trackPayload).catch((error) => {
          console.error('Presence track error:', error)
        })
      }
      updateActiveChannels()
    })
  }

  const unsubscribeFromChannel = (channelName) => {
    const channel = channelsRef.current.get(channelName)
    if (!channel) return

    channel.unsubscribe()
    updateActiveChannels()
  }

  const removeChannel = (channelName) => {
    const channel = channelsRef.current.get(channelName)
    if (channel) {
      channel.unsubscribe()
      channelsRef.current.delete(channelName)
      updateActiveChannels()
    }
  }

  const updateActiveChannels = () => {
    const channels = Array.from(channelsRef.current.entries()).map(([name, channel]) => ({
      name,
      status: channel.state(),
    }))
    setActiveChannels(channels)
  }

  // Postgres changes
  const addPostgresChanges = (channelName) => {
    if (!pgTable.trim()) return

    const channel = channelsRef.current.get(channelName)
    if (!channel) return

    const config = {
      event: pgEvent,
      schema: pgSchema,
      table: pgTable,
    }

    channel.on('postgres_changes', config, (payload) => {
      setPostgresChanges((prev) => [
        ...prev,
        {
          timestamp: new Date().toISOString(),
          channel: channelName,
          ...payload,
        },
      ])
    })
  }

  // Broadcast
  const sendBroadcast = (channelName) => {
    const channel = channelsRef.current.get(channelName)
    if (!channel || !broadcastEvent.trim()) return

    let payload
    try {
      payload = broadcastPayload ? JSON.parse(broadcastPayload) : {}
    } catch (error) {
      console.error('Invalid JSON payload:', error)
      return
    }

    channel.send({
      type: 'broadcast',
      event: broadcastEvent,
      payload,
    })
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 font-mono text-sm">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Realtime-js Interactive Example</h1>
          <p className="text-gray-600 text-xs mt-1">
            Test broadcast, presence, postgres_changes (with RLS), and authorization features
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left Column: Controls */}
          <div className="space-y-4">
            {/* Connection Status */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">1. WebSocket Connection</h2>
              <p className="text-gray-600 text-xs mb-3">
                Manage the WebSocket connection to the Realtime server
              </p>
              <div className="flex items-center gap-2 mb-3">
                <div
                  className={`w-3 h-3 rounded-full ${
                    socketStatus === 'open'
                      ? 'bg-green-500'
                      : socketStatus === 'connecting'
                        ? 'bg-yellow-500'
                        : 'bg-red-500'
                  }`}
                />
                <span className="uppercase font-semibold">{socketStatus}</span>
              </div>
              <div className="space-y-2">
                <button
                  className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors font-semibold"
                  onClick={toggleConnection}
                >
                  {socketStatus === 'open' ? 'Disconnect Socket' : 'Connect Socket'}
                </button>
              </div>
            </div>

            {/* Authentication */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">2. User Authentication</h2>
              <p className="text-gray-600 text-xs mb-3">
                Login to test RLS policies and authorized channels. Credentials can be set via
                environment variables.
              </p>
              {!isAuthenticated ? (
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-gray-600 block mb-1">Email</label>
                    <input
                      type="email"
                      placeholder="user@example.com"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-600 block mb-1">Password</label>
                    <input
                      type="password"
                      placeholder="Enter password"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <button
                    className="w-full px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
                    onClick={handleLogin}
                  >
                    Log In
                  </button>
                  <p className="text-xs text-gray-500 mt-2">
                    Tip: Set NEXT_PUBLIC_TEST_USER_EMAIL and NEXT_PUBLIC_TEST_USER_PASSWORD in
                    .env.local
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="bg-green-50 border border-green-200 rounded p-3">
                    <p className="text-green-700 font-semibold text-xs">✓ Authenticated</p>
                    <p className="text-xs text-gray-600 mt-1 break-all">
                      <span className="font-semibold">User ID:</span> {userId}
                    </p>
                    <p className="text-xs text-gray-600 mt-1">
                      <span className="font-semibold">Email:</span> {email}
                    </p>
                  </div>
                  <button
                    className="w-full px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                    onClick={handleLogout}
                  >
                    Log Out
                  </button>
                </div>
              )}
            </div>

            {/* Create Channel */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">3. Create Channel</h2>
              <p className="text-gray-600 text-xs mb-3">
                Configure and create a new realtime channel with custom settings
              </p>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Channel Name *</label>
                  <input
                    type="text"
                    placeholder="e.g., my-room, game-lobby, chat-1"
                    className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-600 block mb-1">Channel Type</label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                    value={channelType}
                    onChange={(e) => setChannelType(e.target.value)}
                  >
                    <option value="public">Public (anyone can join)</option>
                    <option value="private">Private (requires authentication)</option>
                  </select>
                </div>

                <div className="border-t pt-3">
                  <label className="text-xs text-gray-600 block mb-2 font-semibold">
                    Feature Configuration
                  </label>

                  {/* Broadcast */}
                  <div className="space-y-2 mb-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enableBroadcast}
                        onChange={(e) => setEnableBroadcast(e.target.checked)}
                        className="w-4 h-4"
                      />
                      <span className="text-xs font-semibold">Enable Broadcast</span>
                      <span className="text-xs text-gray-500">(send/receive messages)</span>
                    </label>
                    {enableBroadcast && (
                      <div className="ml-6 space-y-1">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={broadcastAck}
                            onChange={(e) => setBroadcastAck(e.target.checked)}
                            className="w-3 h-3"
                          />
                          <span className="text-xs">Acknowledgments (ack)</span>
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={broadcastSelf}
                            onChange={(e) => setBroadcastSelf(e.target.checked)}
                            className="w-3 h-3"
                          />
                          <span className="text-xs">Receive own messages (self)</span>
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Presence */}
                  <div className="space-y-2 mb-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enablePresence}
                        onChange={(e) => setEnablePresence(e.target.checked)}
                        className="w-4 h-4"
                      />
                      <span className="text-xs font-semibold">Enable Presence</span>
                      <span className="text-xs text-gray-500">(track online users)</span>
                    </label>
                    {enablePresence && (
                      <div className="ml-6">
                        <input
                          type="text"
                          placeholder="Custom presence key (optional)"
                          className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                          value={presenceKey}
                          onChange={(e) => setPresenceKey(e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  {/* Postgres Changes */}
                  <div className="space-y-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={postgresChangesEnabled}
                        onChange={(e) => setPostgresChangesEnabled(e.target.checked)}
                        className="w-4 h-4"
                      />
                      <span className="text-xs font-semibold">Enable Postgres Changes</span>
                      <span className="text-xs text-gray-500">(database events)</span>
                    </label>
                    {postgresChangesEnabled && (
                      <div className="ml-6 space-y-2 text-xs text-gray-600">
                        <p>Configure below in "Postgres Changes Configuration" section</p>
                      </div>
                    )}
                  </div>
                </div>

                <button
                  className="w-full px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 transition-colors font-semibold"
                  onClick={createChannel}
                >
                  Create Channel
                </button>
              </div>
            </div>

            {/* Active Channels */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">4. Active Channels</h2>
              <p className="text-gray-600 text-xs mb-3">
                Manage your subscribed channels and perform actions
              </p>
              {activeChannels.length === 0 ? (
                <div className="text-center py-6 border border-dashed border-gray-300 rounded">
                  <p className="text-gray-500 text-xs">No channels created yet</p>
                  <p className="text-gray-400 text-xs mt-1">
                    Create a channel above to get started
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {activeChannels.map(({ name, status }) => (
                    <div key={name} className="border border-gray-300 rounded p-3 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex-1 min-w-0">
                          <span className="font-semibold text-xs block truncate">{name}</span>
                        </div>
                        <span
                          className={`text-xs px-2 py-1 rounded font-semibold ml-2 ${
                            status === 'joined'
                              ? 'bg-green-100 text-green-800'
                              : status === 'joining'
                                ? 'bg-yellow-100 text-yellow-800'
                                : status === 'leaving'
                                  ? 'bg-orange-100 text-orange-800'
                                  : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {status}
                        </span>
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {status !== 'joined' && (
                          <button
                            className="px-2 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 transition-colors"
                            onClick={() => subscribeToChannel(name)}
                            title="Subscribe to this channel"
                          >
                            Subscribe
                          </button>
                        )}
                        {status === 'joined' && (
                          <>
                            <button
                              className="px-2 py-1 bg-yellow-500 text-white rounded text-xs hover:bg-yellow-600 transition-colors"
                              onClick={() => unsubscribeFromChannel(name)}
                              title="Unsubscribe from this channel"
                            >
                              Unsubscribe
                            </button>
                            <button
                              className="px-2 py-1 bg-green-500 text-white rounded text-xs hover:bg-green-600 transition-colors"
                              onClick={() => sendBroadcast(name)}
                              title="Send a broadcast message"
                            >
                              📡 Broadcast
                            </button>
                            <button
                              className="px-2 py-1 bg-pink-500 text-white rounded text-xs hover:bg-pink-600 transition-colors"
                              onClick={() => addPostgresChanges(name)}
                              title="Add postgres_changes listener"
                            >
                              🗄️ Add PG Listener
                            </button>
                          </>
                        )}
                        <button
                          className="px-2 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600 transition-colors"
                          onClick={() => removeChannel(name)}
                          title="Remove this channel"
                        >
                          ✕ Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Broadcast Config */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">5. Broadcast Configuration</h2>
              <p className="text-gray-600 text-xs mb-3">
                Configure and send broadcast messages to specific channels
              </p>
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Event Name</label>
                  <input
                    type="text"
                    placeholder="e.g., message, user-joined, game-update"
                    className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                    value={broadcastEvent}
                    onChange={(e) => setBroadcastEvent(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Payload (JSON format)</label>
                  <textarea
                    placeholder='{"message": "Hello!", "user": "Alice", "timestamp": 1234567890}'
                    className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-xs"
                    rows={3}
                    value={broadcastPayload}
                    onChange={(e) => setBroadcastPayload(e.target.value)}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty for no payload, or provide valid JSON
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600 mb-2">
                    Select a subscribed channel below to send this broadcast:
                  </p>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {activeChannels.filter((ch) => ch.status === 'joined').length === 0 ? (
                      <div className="text-center py-3 border border-dashed border-gray-300 rounded">
                        <p className="text-gray-500 text-xs">No subscribed channels</p>
                        <p className="text-gray-400 text-xs">Subscribe to a channel first</p>
                      </div>
                    ) : (
                      activeChannels
                        .filter((ch) => ch.status === 'joined')
                        .map(({ name }) => (
                          <button
                            key={name}
                            className="w-full px-3 py-2 bg-green-500 text-white rounded text-xs hover:bg-green-600 transition-colors text-left"
                            onClick={() => sendBroadcast(name)}
                          >
                            📡 Send to: {name}
                          </button>
                        ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Presence Config */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">6. Presence Configuration</h2>
              <p className="text-gray-600 text-xs mb-3">
                Configure presence tracking payload (automatically sent on subscribe if presence is
                enabled)
              </p>
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">
                    Track Payload (JSON format)
                  </label>
                  <textarea
                    placeholder='{"status": "online", "name": "Alice", "avatar": "url"}'
                    className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-xs"
                    rows={3}
                    value={presencePayload}
                    onChange={(e) => setPresencePayload(e.target.value)}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Default: {`{"online_at": "<timestamp>"}`}
                  </p>
                </div>
              </div>
            </div>

            {/* Postgres Changes Config */}
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-bold mb-2 text-lg">7. Postgres Changes Configuration</h2>
              <p className="text-gray-600 text-xs mb-3">
                Configure database change listeners for realtime updates (respects RLS policies)
              </p>
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Schema</label>
                  <input
                    type="text"
                    placeholder="public"
                    className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                    value={pgSchema}
                    onChange={(e) => setPgSchema(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Table Name *</label>
                  <input
                    type="text"
                    placeholder="e.g., messages, users, posts"
                    className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                    value={pgTable}
                    onChange={(e) => setPgTable(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Event Type</label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded text-xs"
                    value={pgEvent}
                    onChange={(e) => setPgEvent(e.target.value)}
                  >
                    <option value="*">All Events (*)</option>
                    <option value="INSERT">INSERT only</option>
                    <option value="UPDATE">UPDATE only</option>
                    <option value="DELETE">DELETE only</option>
                  </select>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded p-2 mt-2">
                  <p className="text-xs text-blue-800">
                    <span className="font-semibold">Note:</span> Postgres changes respect Row Level
                    Security (RLS) policies. Make sure you're authenticated and have proper
                    permissions.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Data Tables */}
          <div className="space-y-4">
            {/* Broadcast Messages Table */}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-bold text-lg">Broadcast Messages</h2>
                <button
                  className="px-3 py-1 bg-gray-500 text-white rounded text-xs hover:bg-gray-600"
                  onClick={() => setBroadcastMessages([])}
                >
                  Clear
                </button>
              </div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                {broadcastMessages.length === 0 ? (
                  <p className="text-gray-500 text-center py-4 text-xs">
                    No broadcast messages yet
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-100 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left">Time</th>
                        <th className="px-2 py-1 text-left">Channel</th>
                        <th className="px-2 py-1 text-left">Event</th>
                        <th className="px-2 py-1 text-left">Payload</th>
                      </tr>
                    </thead>
                    <tbody>
                      {broadcastMessages.map((msg, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-2 py-1 whitespace-nowrap align-top">
                            {new Date(msg.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="px-2 py-1 align-top">{msg.channel}</td>
                          <td className="px-2 py-1 align-top">{msg.event}</td>
                          <td className="px-2 py-1">
                            <pre className="text-xs overflow-x-auto">
                              {JSON.stringify(msg.payload, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Postgres Changes Table */}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-bold text-lg">Postgres Changes</h2>
                <button
                  className="px-3 py-1 bg-gray-500 text-white rounded text-xs hover:bg-gray-600"
                  onClick={() => setPostgresChanges([])}
                >
                  Clear
                </button>
              </div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                {postgresChanges.length === 0 ? (
                  <p className="text-gray-500 text-center py-4 text-xs">No postgres changes yet</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-100 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left">Time</th>
                        <th className="px-2 py-1 text-left">Channel</th>
                        <th className="px-2 py-1 text-left">Event</th>
                        <th className="px-2 py-1 text-left">Table</th>
                        <th className="px-2 py-1 text-left">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {postgresChanges.map((change, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-2 py-1 whitespace-nowrap align-top">
                            {new Date(change.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="px-2 py-1 align-top">{change.channel}</td>
                          <td className="px-2 py-1 align-top">
                            {change.eventType || change.event}
                          </td>
                          <td className="px-2 py-1 align-top">{change.table}</td>
                          <td className="px-2 py-1">
                            <pre className="text-xs overflow-x-auto">
                              {JSON.stringify(change.new || change.old || change, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Presence State */}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-bold text-lg">Presence State</h2>
                <button
                  className="px-3 py-1 bg-gray-500 text-white rounded text-xs hover:bg-gray-600"
                  onClick={() => setPresenceState({})}
                >
                  Clear
                </button>
              </div>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {Object.keys(presenceState).length === 0 ? (
                  <p className="text-gray-500 text-center py-4 text-xs">No presence data yet</p>
                ) : (
                  Object.entries(presenceState).map(([channel, state]) => (
                    <div key={channel} className="border border-gray-200 rounded p-2">
                      <h3 className="font-semibold text-xs mb-2">{channel}</h3>
                      <div className="space-y-2">
                        {Object.entries(state).map(([key, presences]) => (
                          <div key={key} className="bg-gray-50 rounded p-2">
                            <p className="font-semibold text-xs mb-1">User: {key}</p>
                            {Array.isArray(presences) &&
                              presences.map((presence, idx) => (
                                <pre key={idx} className="text-xs overflow-x-auto">
                                  {JSON.stringify(presence, null, 2)}
                                </pre>
                              ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
