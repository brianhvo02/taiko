/**
 * The live connections: each device that has the player open holds one stream from the server (`GET events`), and
 * tells the server what it is playing (`POST state`). The server passes that on to the same user's other devices,
 * and carries their commands to each other (`POST devices/:id/command`): that is remote control. Nothing here is
 * kept on disk; a device that closes its stream is gone from the list, and a restart forgets everything.
 *
 * The stream is server-sent events (`data: <json>` and a blank line), read by the player with `fetch`, since the
 * browser's own EventSource can't send the token.
 */
import type { ServerResponse } from 'node:http';
import type { LiveDevice, LiveEvent, PlaybackState, RemoteCommand, Room } from '../../src/shared/api';
import type { Device } from './auth';

interface Connection {
  device: Device;
  response: ServerResponse;
}

export class LiveHub {
  private readonly connections = new Set<Connection>();
  /** What each device last said it is playing, by device id. */
  private readonly states = new Map<string, PlaybackState>();
  /** When each of those was heard, by the server's clock. */
  private readonly heardAt = new Map<string, number>();
  /** Listening together: the devices that are sharing what they play (by id, with the name of whose they are), and which sharing device each listener follows. */
  private readonly sharing = new Map<string, string>();
  private readonly following = new Map<string, string>();
  private readonly keepAlive: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now) {
    // A line that says nothing, so that a proxy doesn't close a stream it takes for dead.
    this.keepAlive = setInterval(() => {
      for (const connection of this.connections) this.write(connection, ': still here\n\n');
    }, 25_000);
    this.keepAlive.unref?.();
  }

  /** Writes to a stream, unless it has closed: a device can go at any moment, and a write to it must not hurt. */
  private write(connection: Connection, text: string): void {
    const { response } = connection;
    if (response.destroyed || response.writableEnded) return;
    try {
      response.write(text);
    } catch {
      // Gone between the look and the write; its closing takes it off the list.
    }
  }

  private send(connection: Connection, event: LiveEvent): void {
    this.write(connection, `data: ${JSON.stringify(event)}\n\n`);
  }

  /** A user's devices that are connected, each with what it is playing. */
  private devicesOf(userId: string): LiveDevice[] {
    const seen = new Map<string, LiveDevice>();
    for (const { device } of this.connections) {
      if (device.userId === userId && !seen.has(device.id)) seen.set(device.id, { id: device.id, name: device.name, state: this.states.get(device.id) ?? null });
    }
    return [...seen.values()];
  }

  /** Tells each of a user's connected devices who else is there, and which of them it is itself. */
  private announce(userId: string): void {
    const devices = this.devicesOf(userId);
    for (const connection of this.connections) {
      if (connection.device.userId === userId) this.send(connection, { type: 'devices', you: connection.device.id, devices });
    }
  }

  /** Takes on a device's stream. The returned function is for when the stream closes. */
  connect(device: Device, response: ServerResponse): () => void {
    const connection = { device, response };
    // A stream that breaks says so with an error; unheard, that would stop the whole server.
    response.on('error', () => {});
    this.connections.add(connection);
    this.announce(device.userId);
    this.send(connection, { type: 'rooms', rooms: this.rooms(), joined: this.following.get(device.id) ?? null });
    return () => {
      this.connections.delete(connection);
      // What it was playing is forgotten once its last stream is gone; so is its sharing, and its listening along.
      if (![...this.connections].some((other) => other.device.id === device.id)) {
        this.states.delete(device.id);
        this.heardAt.delete(device.id);
        this.following.delete(device.id);
        if (this.sharing.delete(device.id)) for (const [listener, room] of this.following) if (room === device.id) this.following.delete(listener);
        this.announceRooms();
      }
      this.announce(device.userId);
    };
  }

  /** A device says what it is playing; what it leaves out stays as it last said. */
  setState(device: Device, state: Partial<PlaybackState>): void {
    const before = this.states.get(device.id);
    const next = { playing: false, position: 0, duration: 0, at: 0, track: null, ...before, ...state };
    this.states.set(device.id, next);
    this.heardAt.set(device.id, this.now());
    this.announce(device.userId);
    if (this.sharing.has(device.id)) {
      this.tellListeners(device.id);
      // The list of who is sharing names the song: it is told again when the song changes.
      if (before?.track?.id !== next.track?.id) this.announceRooms();
    }
  }

  /** Carries a command to another device of the same user. False when that device isn't connected, or isn't theirs. */
  command(from: Device, targetId: string, command: RemoteCommand): boolean {
    let reached = false;
    for (const connection of this.connections) {
      if (connection.device.id !== targetId || connection.device.userId !== from.userId) continue;
      this.send(connection, { type: 'command', from: from.id, command });
      reached = true;
    }
    return reached;
  }

  /* ---------- Listening together ---------- */

  private rooms(): Room[] {
    const named = new Map<string, string>();
    for (const { device } of this.connections) named.set(device.id, device.name);
    return [...this.sharing].map(([id, by]) => ({
      id, by, device: named.get(id) ?? '', track: this.states.get(id)?.track ?? null,
      listeners: [...this.following.values()].filter((room) => room === id).length,
    }));
  }

  /** Tells everyone who is sharing, and each device whom it is listening along with. */
  private announceRooms(): void {
    const rooms = this.rooms();
    for (const connection of this.connections) this.send(connection, { type: 'rooms', rooms, joined: this.following.get(connection.device.id) ?? null });
  }

  /** Tells a sharing device's listeners what it is playing, with the server's time for them to reckon by. */
  private tellListeners(roomId: string, only?: string): void {
    const state = this.states.get(roomId);
    if (!state) return;
    const room = { id: roomId, state: { ...state, queue: undefined, order: undefined }, heardAt: this.heardAt.get(roomId) ?? this.now(), now: this.now() };
    for (const connection of this.connections) {
      const id = connection.device.id;
      if (this.following.get(id) === roomId && (!only || only === id)) this.send(connection, { type: 'room', room });
    }
  }

  /** A device starts letting everyone listen along (`by` is whose it is), or stops. */
  share(device: Device, by: string, on: boolean): void {
    if (on) {
      this.sharing.set(device.id, by);
      this.following.delete(device.id);
    } else {
      this.sharing.delete(device.id);
      for (const [listener, room] of this.following) if (room === device.id) this.following.delete(listener);
    }
    this.announceRooms();
  }

  /** A device starts listening along with a sharing device, or stops. False when that device isn't sharing. */
  follow(device: Device, roomId: string | null): boolean {
    if (roomId === null) {
      this.following.delete(device.id);
      this.announceRooms();
      return true;
    }
    if (!this.sharing.has(roomId) || roomId === device.id) return false;
    this.sharing.delete(device.id);
    this.following.set(device.id, roomId);
    this.announceRooms();
    this.tellListeners(roomId, device.id);
    return true;
  }

  /** Closes every stream: the server is stopping. */
  close(): void {
    clearInterval(this.keepAlive);
    for (const connection of this.connections) connection.response.end();
    this.connections.clear();
  }
}
