import ProtocolMessage from '../types/protocolmessage';
import * as Utils from '../util/utils';
import EventEmitter from '../util/eventemitter';
import Logger from '../util/logger';
import ConnectionErrors from './connectionerrors';
import ErrorInfo from '../types/errorinfo';
import Auth from '../client/auth';
import * as API from '../../../ably';
import ConnectionManager, { TransportParams } from './connectionmanager';

export type TryConnectCallback = (
  wrappedErr: { error: ErrorInfo; event: string } | null,
  transport?: Transport
) => void;

const actions = ProtocolMessage.Action;
const closeMessage = ProtocolMessage.fromValues({ action: actions.CLOSE });
const disconnectMessage = ProtocolMessage.fromValues({ action: actions.DISCONNECT });

/*
 * Transport instances inherit from EventEmitter and emit the following events:
 *
 * event name       data
 * closed           error
 * failed           error
 * disposed
 * connected        null error, connectionSerial, connectionId, connectionDetails
 * sync             connectionSerial, connectionId
 * event            channel message object
 */

abstract class Transport extends EventEmitter {
  connectionManager: ConnectionManager;
  auth: Auth;
  params: TransportParams;
  timeouts: Record<string, number>;
  format?: Utils.Format;
  isConnected: boolean;
  isFinished: boolean;
  isDisposed: boolean;
  maxIdleInterval: number | null;
  idleTimer: NodeJS.Timeout | number | null;
  lastActivity: number | null;

  constructor(connectionManager: ConnectionManager, auth: Auth, params: TransportParams, forceJsonProtocol?: boolean) {
    super();
    if (forceJsonProtocol) {
      params.format = undefined;
      params.heartbeats = true;
    }
    this.connectionManager = connectionManager;
    connectionManager.registerProposedTransport(this);
    this.auth = auth;
    this.params = params;
    this.timeouts = params.options.timeouts;
    this.format = params.format;
    this.isConnected = false;
    this.isFinished = false;
    this.isDisposed = false;
    this.maxIdleInterval = null;
    this.idleTimer = null;
    this.lastActivity = null;
  }

  abstract shortName: string;
  abstract send(message: ProtocolMessage): void;

  connect(): void {}

  close(): void {
    if (this.isConnected) {
      this.requestClose();
    }
    this.finish('closed', ConnectionErrors.closed);
  }

  disconnect(err?: Error | ErrorInfo): void {
    /* Used for network/transport issues that need to result in the transport
     * being disconnected, but should not transition the connection to 'failed' */
    if (this.isConnected) {
      this.requestDisconnect();
    }
    this.finish('disconnected', err || ConnectionErrors.disconnected);
  }

  fail(err: ErrorInfo): void {
    /* Used for client-side-detected fatal connection issues */
    if (this.isConnected) {
      this.requestDisconnect();
    }
    this.finish('failed', err || ConnectionErrors.failed);
  }

  finish(event: string, err?: Error | ErrorInfo): void {
    if (this.isFinished) {
      return;
    }

    this.isFinished = true;
    this.isConnected = false;
    this.maxIdleInterval = null;
    clearTimeout(this.idleTimer ?? undefined);
    this.idleTimer = null;
    this.emit(event, err);
    this.dispose();
  }

  onProtocolMessage(message: ProtocolMessage): void {
    if (Logger.shouldLog(Logger.LOG_MICRO)) {
      Logger.logAction(
        Logger.LOG_MICRO,
        'Transport.onProtocolMessage()',
        'received on ' +
          this.shortName +
          ': ' +
          ProtocolMessage.stringify(message) +
          '; connectionId = ' +
          this.connectionManager.connectionId
      );
    }
    this.onActivity();

    switch (message.action) {
      case actions.HEARTBEAT:
        Logger.logAction(
          Logger.LOG_MICRO,
          'Transport.onProtocolMessage()',
          this.shortName + ' heartbeat; connectionId = ' + this.connectionManager.connectionId
        );
        this.emit('heartbeat', message.id);
        break;
      case actions.CONNECTED:
        this.onConnect(message);
        this.emit('connected', message.error, message.connectionId, message.connectionDetails, message);
        break;
      case actions.CLOSED:
        this.onClose(message);
        break;
      case actions.DISCONNECTED:
        this.onDisconnect(message);
        break;
      case actions.ACK:
        this.emit('ack', message.msgSerial, message.count);
        break;
      case actions.NACK:
        this.emit('nack', message.msgSerial, message.count, message.error);
        break;
      case actions.SYNC:
        if (message.connectionId !== undefined) {
          /* a transport SYNC */
          this.emit('sync', message.connectionId, message);
          break;
        }
        /* otherwise it's a channel SYNC, so handle it in the channel */
        this.connectionManager.onChannelMessage(message, this);
        break;
      case actions.AUTH:
        this.auth.authorize(function (err: ErrorInfo) {
          if (err) {
            Logger.logAction(
              Logger.LOG_ERROR,
              'Transport.onProtocolMessage()',
              'Ably requested re-authentication, but unable to obtain a new token: ' + Utils.inspectError(err)
            );
          }
        });
        break;
      case actions.ERROR:
        Logger.logAction(
          Logger.LOG_MINOR,
          'Transport.onProtocolMessage()',
          'received error action; connectionId = ' +
            this.connectionManager.connectionId +
            '; err = ' +
            Utils.inspect(message.error) +
            (message.channel ? ', channel: ' + message.channel : '')
        );
        if (message.channel === undefined) {
          this.onFatalError(message);
          break;
        }
        /* otherwise it's a channel-specific error, so handle it in the channel */
        this.connectionManager.onChannelMessage(message, this);
        break;
      default:
        /* all other actions are channel-specific */
        this.connectionManager.onChannelMessage(message, this);
    }
  }

  onConnect(message: ProtocolMessage): void {
    this.isConnected = true;
    if (!message.connectionDetails) {
      throw new Error('Transport.onConnect(): Connect message recieved without connectionDetails');
    }
    const maxPromisedIdle = message.connectionDetails.maxIdleInterval as number;
    if (maxPromisedIdle) {
      this.maxIdleInterval = maxPromisedIdle + this.timeouts.realtimeRequestTimeout;
      this.onActivity();
    }
    /* else Realtime declines to guarantee any maximum idle interval - CD2h */
  }

  onDisconnect(message: ProtocolMessage): void {
    /* Used for when the server has disconnected the client (usually with a
     * DISCONNECTED action) */
    const err = message && message.error;
    Logger.logAction(Logger.LOG_MINOR, 'Transport.onDisconnect()', 'err = ' + Utils.inspectError(err));
    this.finish('disconnected', err);
  }

  onFatalError(message: ProtocolMessage): void {
    /* On receipt of a fatal connection error, we can assume that the server
     * will close the connection and the transport, and do not need to request
     * a disconnection - RTN15i */
    const err = message && message.error;
    Logger.logAction(Logger.LOG_MINOR, 'Transport.onFatalError()', 'err = ' + Utils.inspectError(err));
    this.finish('failed', err);
  }

  onClose(message: ProtocolMessage): void {
    const err = message && message.error;
    Logger.logAction(Logger.LOG_MINOR, 'Transport.onClose()', 'err = ' + Utils.inspectError(err));
    this.finish('closed', err);
  }

  requestClose(): void {
    Logger.logAction(Logger.LOG_MINOR, 'Transport.requestClose()', '');
    this.send(closeMessage);
  }

  requestDisconnect(): void {
    Logger.logAction(Logger.LOG_MINOR, 'Transport.requestDisconnect()', '');
    this.send(disconnectMessage);
  }

  ping(id: string): void {
    const msg: Record<string, number | string> = { action: ProtocolMessage.Action.HEARTBEAT };
    if (id) msg.id = id;
    this.send(ProtocolMessage.fromValues(msg));
  }

  dispose(): void {
    Logger.logAction(Logger.LOG_MINOR, 'Transport.dispose()', '');
    this.isDisposed = true;
    this.off();
  }

  onActivity(): void {
    if (!this.maxIdleInterval) {
      return;
    }
    this.lastActivity = this.connectionManager.lastActivity = Utils.now();
    this.setIdleTimer(this.maxIdleInterval + 100);
  }

  setIdleTimer(timeout: number): void {
    if (!this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.onIdleTimerExpire();
      }, timeout);
    }
  }

  onIdleTimerExpire(): void {
    if (!this.lastActivity || !this.maxIdleInterval) {
      throw new Error('Transport.onIdleTimerExpire(): lastActivity/maxIdleInterval not set');
    }
    this.idleTimer = null;
    const sinceLast = Utils.now() - this.lastActivity;
    const timeRemaining = this.maxIdleInterval - sinceLast;
    if (timeRemaining <= 0) {
      const msg = 'No activity seen from realtime in ' + sinceLast + 'ms; assuming connection has dropped';
      Logger.logAction(Logger.LOG_ERROR, 'Transport.onIdleTimerExpire()', msg);
      this.disconnect(new ErrorInfo(msg, 80003, 408));
    } else {
      this.setIdleTimer(timeRemaining + 100);
    }
  }

  static tryConnect?: (
    connectionManager: ConnectionManager,
    auth: Auth,
    transportParams: TransportParams,
    callback: TryConnectCallback
  ) => void;
  onAuthUpdated?: (tokenDetails: API.Types.TokenDetails) => void;
}

export default Transport;
