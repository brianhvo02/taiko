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
import type { LiveDevice, LiveEvent, PlaybackState, RemoteCommand } from '../../src/shared/api';
import type { Device } from './auth';

interface Connection {
  device: Device;
  response: ServerResponse;
}

export class LiveHub {
  private readonly connections = new Set<Connection>();
  /** What each device last said it is playing, by device id. */
  private readonly states = new Map<string, PlaybackState>();
  private readonly keepAlive: ReturnType<typeof setInterval>;

  constructor() {
    // A line that says nothing, so that a proxy doesn't close a stream it takes for dead.
    this.keepAlive = setInterval(() => {
      for (const connection of this.connections) connection.response.write(': still here\n\n');
    }, 25_000);
    this.keepAlive.unref?.();
  }

  private send(connection: Connection, event: LiveEvent): void {
    connection.response.write(`data: ${JSON.stringify(event)}\n\n`);
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
    this.connections.add(connection);
    this.announce(device.userId);
    return () => {
      this.connections.delete(connection);
      // What it was playing is forgotten once its last stream is gone.
      if (![...this.connections].some((other) => other.device.id === device.id)) this.states.delete(device.id);
      this.announce(device.userId);
    };
  }

  /** A device says what it is playing; what it leaves out stays as it last said. */
  setState(device: Device, state: Partial<PlaybackState>): void {
    const before = this.states.get(device.id);
    this.states.set(device.id, { playing: false, position: 0, duration: 0, at: 0, track: null, ...before, ...state });
    this.announce(device.userId);
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

  /** Closes every stream: the server is stopping. */
  close(): void {
    clearInterval(this.keepAlive);
    for (const connection of this.connections) connection.response.end();
    this.connections.clear();
  }
}
